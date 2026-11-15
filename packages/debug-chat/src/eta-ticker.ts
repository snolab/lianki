import { type EtaTask, compactTime, splitTitle } from "./eta";
import { OWNER_NAME } from "./state-tree";
import type { ChatStrings } from "./wire";

/**
 * The ETA bar's change ticker (owner, 2026-11-15 20:1x JST: "agent 对我们的甘特图，
 * 有任何一个任务进行更新的时候，你就在这里播报一下，不管是新增还是延迟，还是我们
 * 超前完成"). Each new snapshot of the timed tasks is compared with the last
 * one; a change is announced in the bar, in place of its summary, for
 * `chat.etaTickerSec` seconds each, the recent ones (at most
 * `chat.etaTickerKeep`, newest first) in turn, then the summary comes back.
 * A change the owner made himself (its last ETA event is by "owner") is not
 * announced; neither is anything in the first snapshot (that is the page
 * loading, not a change). Pure; the page's hook is eta-ticker-hook.ts.
 */

/** Defaults of the config keys chat.etaTickerSec / chat.etaTickerKeep (lib/config.ts). */
export const ETA_TICKER_SEC = 6;
// 1 (owner, 2026-11-15 22:32 JST): no carousel of past changes — the bar shows the
// change an agent just made, for a few seconds, then the summary; quiet otherwise.
export const ETA_TICKER_KEEP = 1;

export type TickerKind = "new" | "done" | "early" | "later" | "blocked" | "waiting" | "late";

export type TickerItem = {
  /** One per change: the same change seen twice is announced once. */
  key: string;
  kind: TickerKind;
  /** The task's node id. */
  id: string;
  title: string;
  /** The lane or agent that made it, when known (the task's last ETA event). */
  by?: string;
  /** "later": how much later the estimate is; "early": how long before its ETA it was done. */
  deltaMs?: number;
};

/** A later estimate below this moves nothing the bar can show (its unit is a minute). */
const MIN_DELTA_MS = 60_000;

const lastBy = (t: EtaTask) => t.ticks?.at(-1)?.by;

/**
 * The changes from `prev` to `next` (both the bar's tasks). `prev` null: the
 * first snapshot, nothing to announce.
 */
export function etaChanges(prev: readonly EtaTask[] | null, next: readonly EtaTask[], now: number): TickerItem[] {
  if (!prev) return [];
  const before = new Map(prev.map((t) => [t.id, t]));
  const out: TickerItem[] = [];
  for (const t of next) {
    const p = before.get(t.id);
    const by = lastBy(t);
    if (by === OWNER_NAME) continue;
    const base = { id: t.id, title: t.title, ...(by ? { by } : {}) };
    if (!p) {
      if (!t.done) out.push({ ...base, key: `new:${t.id}`, kind: "new" });
      continue;
    }
    if (t.done) {
      if (p.done) continue;
      const doneAt = t.doneAt ?? now;
      const ahead = t.at - doneAt;
      out.push(
        ahead >= MIN_DELTA_MS
          ? { ...base, key: `done:${t.id}`, kind: "early", deltaMs: ahead }
          : { ...base, key: `done:${t.id}`, kind: "done" },
      );
      continue;
    }
    if (t.parked && t.parked !== p.parked) {
      const kind = t.parked === "owner" ? "waiting" : "blocked";
      out.push({ ...base, key: `${kind}:${t.id}:${t.at}`, kind });
      continue;
    }
    if (!t.parked && !p.parked && t.at - p.at >= MIN_DELTA_MS) {
      out.push({ ...base, key: `later:${t.id}:${t.at}`, kind: "later", deltaMs: t.at - p.at });
      continue;
    }
    // The hub marked it pinged (its ETA passed while this page was away).
    if (t.sent && !p.sent && !t.parked && !t.queued)
      out.push({ ...base, key: `late:${t.id}:${t.at}`, kind: "late" });
  }
  return out;
}

/** Open, running tasks whose ETA was reached between `from` and `to` (the page's clock). */
export function lateCrossings(tasks: readonly EtaTask[], from: number, to: number): TickerItem[] {
  return tasks
    .filter((t) => !t.done && !t.parked && !t.queued && t.at > from && t.at <= to)
    .map((t) => ({ key: `late:${t.id}:${t.at}`, kind: "late" as const, id: t.id, title: t.title }));
}

export type TickerState = {
  /** Newest first, at most `keep`. */
  items: TickerItem[];
  /** When the current pass began (the latest arrival); null before any. */
  since: number | null;
};

export const TICKER_EMPTY: TickerState = { items: [], since: null };

/** New changes arrive: they lead the queue and a pass starts over. A key already queued is not repeated. */
export function tickerPush(s: TickerState, items: readonly TickerItem[], now: number, keep: number): TickerState {
  const have = new Set(s.items.map((i) => i.key));
  const fresh: TickerItem[] = [];
  for (const i of items) {
    if (have.has(i.key)) continue;
    have.add(i.key);
    fresh.push(i);
  }
  if (!fresh.length) return s;
  return { items: [...fresh.reverse(), ...s.items].slice(0, Math.max(1, keep)), since: now };
}

/** What the bar shows at `now`: one item for `secMs` each, newest first, then null (the summary). */
export function tickerShown(s: TickerState, now: number, secMs: number): TickerItem | null {
  if (s.since === null || secMs <= 0 || now < s.since) return null;
  return s.items[Math.floor((now - s.since) / secMs)] ?? null;
}

/** When the shown item next changes (to wake a render), or null when the pass is over. */
export function tickerNextWake(s: TickerState, now: number, secMs: number): number | null {
  if (s.since === null || secMs <= 0) return null;
  const end = s.since + s.items.length * secMs;
  if (now >= end) return null;
  return s.since + (Math.floor((now - s.since) / secMs) + 1) * secMs;
}

export type TickerText = Pick<
  ChatStrings,
  | "etaNewsNew"
  | "etaNewsDone"
  | "etaNewsEarly"
  | "etaNewsLater"
  | "etaNewsBlocked"
  | "etaNewsWaiting"
  | "etaNewsLate"
>;

const TEMPLATE: Record<TickerKind, keyof TickerText> = {
  new: "etaNewsNew",
  done: "etaNewsDone",
  early: "etaNewsEarly",
  later: "etaNewsLater",
  blocked: "etaNewsBlocked",
  waiting: "etaNewsWaiting",
  late: "etaNewsLate",
};

/** The announcement: the kind's template with the task's name ({task}) and the time ({t}: "20M"). */
export function tickerText(i: TickerItem, s: TickerText): string {
  return s[TEMPLATE[i.kind]]
    .replace("{task}", splitTitle(i.title).name)
    .replace("{t}", compactTime(i.deltaMs ?? 0));
}

export type TickerConfig = { sec: number; keep: number };
