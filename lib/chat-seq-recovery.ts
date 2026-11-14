/** Rendered/recovered transport coverage. Durable acceptance and viewport reads are separate cursors. */
import type { ChatMessage } from "@/lib/dev-eval";

export type ReplayItem = ChatMessage | { id: string; seq: number; removed: true };
export type ReplayEnvelope = {
  afterSeq: number;
  throughSeq: number;
  headSeq: number;
  prunedThroughSeq: number;
  thread?: string;
  skipped?: readonly { from: number; to: number }[];
};
const seq = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
type Interval = { from: number; to: number };

export function createChatSeqRecovery(d: {
  batch: () => number;
  request: (range: { type: "replay"; afterSeq: number; throughSeq: number }) => boolean;
}) {
  let thread: string | undefined;
  let cursor: number | undefined;
  let head = 0;
  let pruned = 0;
  let covered: Interval[] = [];
  let flight: { afterSeq: number; throughSeq: number } | null = null;
  const versions = new Map<string, number>();
  const removed = new Set<string>();
  const cover = (from: number, to: number) => {
    if (to < from) return;
    const all = [...covered, { from, to }].sort((a, b) => a.from - b.from);
    covered = [];
    for (const interval of all) {
      const last = covered.at(-1);
      if (last && interval.from <= last.to + 1) last.to = Math.max(last.to, interval.to);
      else covered.push({ ...interval });
    }
    if (cursor !== undefined) {
      for (const interval of covered) {
        if (interval.from > cursor + 1) break;
        cursor = Math.max(cursor, interval.to);
      }
      covered = covered.filter((interval) => interval.to > cursor!);
    }
  };
  const request = () => {
    if (cursor === undefined || flight || cursor >= head) return;
    const raw = d.batch();
    const batch = Number.isFinite(raw) ? Math.max(1, Math.min(500, Math.floor(raw))) : 100;
    const nextCovered = covered.find((interval) => interval.from > cursor!);
    const throughSeq = Math.min(head, cursor + batch, nextCovered ? nextCovered.from - 1 : head);
    const range = { type: "replay" as const, afterSeq: cursor, throughSeq };
    flight = { afterSeq: cursor, throughSeq };
    try {
      if (d.request(range)) return;
    } catch {}
    flight = null;
  };
  return {
    cursor: () => cursor,
    version: (id: string) => versions.get(id),
    thread: () => thread,
    prunedThrough: () => pruned,
    /** Reconnect reissues gaps; a successful socket write never means coverage. */
    disconnect() {
      flight = null;
    },
    notice(n: unknown) {
      if (!seq(n) || n === 0) return;
      head = Math.max(head, n);
      request();
    },
    observe(n: unknown) {
      if (!seq(n) || n === 0) return;
      head = Math.max(head, n);
      cover(n, n);
      request();
    },
    history(raw: Partial<ReplayEnvelope>) {
      const { afterSeq: after, throughSeq: through, headSeq: top, prunedThroughSeq: floor } = raw;
      if (
        !seq(after) ||
        !seq(through) ||
        !seq(top) ||
        !seq(floor) ||
        after > through ||
        through > top ||
        floor > top
      )
        return { valid: false, initial: false };
      const changedThread =
        typeof raw.thread === "string" && thread !== undefined && raw.thread !== thread;
      if (changedThread) {
        cursor = undefined;
        head = 0;
        pruned = 0;
        covered = [];
        flight = null;
        versions.clear();
        removed.clear();
      }
      if (typeof raw.thread === "string") thread = raw.thread;
      const initial = cursor === undefined;
      if (initial) cursor = after; // The hub's authoritative initial retained-window baseline.
      head = Math.max(head, top);
      pruned = Math.max(pruned, floor);
      cover(1, pruned);
      cover(after + 1, through); // Complete server range includes non-visible/removed versions.
      for (const interval of raw.skipped ?? [])
        if (
          seq(interval.from) &&
          seq(interval.to) &&
          interval.from > 0 &&
          interval.from <= interval.to &&
          interval.to <= top
        )
          cover(interval.from, interval.to);
      if (flight && (through > flight.afterSeq || pruned >= flight.throughSeq)) flight = null;
      request();
      return { valid: true, initial };
    },
    /** Current line version wins; stable id and logical timestamp keep an edited row in place. */
    merge(
      current: readonly ChatMessage[],
      incoming: readonly ReplayItem[],
      initial = false,
    ): ChatMessage[] {
      const incomingIds = new Set(
        incoming.flatMap((item) => (item && typeof item.id === "string" ? [item.id] : [])),
      );
      const lines = new Map<string, ChatMessage>();
      for (const message of current) {
        const n = message.seq;
        if (thread && message.thread && message.thread !== thread) continue;
        if (seq(n) && n > 0 && n <= pruned) continue;
        if (initial && !seq(n) && !incomingIds.has(message.id)) continue;
        if (removed.has(message.id) && (!seq(n) || n <= (versions.get(message.id) ?? 0))) continue;
        lines.set(message.id, message);
        if (seq(n)) versions.set(message.id, Math.max(versions.get(message.id) ?? 0, n));
      }
      for (const item of incoming) {
        if (!item || typeof item.id !== "string") continue;
        if ("thread" in item && thread && item.thread && item.thread !== thread) continue;
        const n = item.seq;
        if (seq(n) && n > 0 && n <= pruned) continue;
        const previous = lines.get(item.id);
        const known = Math.max(versions.get(item.id) ?? 0, previous?.seq ?? 0);
        if (seq(n) && n < known) continue;
        if (!seq(n) && known > 0) continue;
        if (seq(n)) versions.set(item.id, n);
        if ("removed" in item && item.removed === true) {
          removed.add(item.id);
          lines.delete(item.id);
          continue;
        }
        if (removed.has(item.id) && (!seq(n) || n <= known)) continue;
        removed.delete(item.id);
        if (!("text" in item) || typeof item.text !== "string") continue;
        // Legacy cache/live edits had no version; do not roll a newer local edit backwards.
        if (!seq(n) && previous?.edited && (item.edited?.at ?? 0) < previous.edited.at) continue;
        lines.set(item.id, item);
      }
      return [...lines.values()].sort(
        (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    },
  };
}
