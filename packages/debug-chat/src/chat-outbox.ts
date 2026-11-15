/**
 * Per-account delivery queue, durable on the device (docs/dev-debug-widget.md,
 * "Pending input and durable chat acceptance"). A socket write is not an
 * acknowledgement: an entry with no receipt within `ackTimeoutMs` is sent again
 * under the same id (the hub de-duplicates by id), backing off up to
 * `ACK_BACKOFF_CAP`× the timeout until the next receipt.
 */
import { MAX_CHAT } from "./wire";

export type OutgoingChat = { id: string; text: string; rejected?: string; [key: string]: unknown };
export type OutgoingDraft = { text: string; [key: string]: unknown };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** Largest multiple of the receipt timeout between resends of an unacknowledged line. */
export const ACK_BACKOFF_CAP = 8;
/** The local refusal reason of a line resent `maxResends` times with no receipt. */
export const NO_RECEIPT = "no-receipt";
/** Up to this share of the wait is added at random, so two tabs do not resend in lockstep. */
const ACK_JITTER = 0.25;
/** The longest line kept on the device; a longer one is cut into MAX_CHAT parts as it is sent. */
const MAX_STORED = 200_000;

/** Where a long line may be cut, best first: a paragraph, a line, a sentence, a clause, a space. */
const CUTS = [/\n\s*\n/g, /\n/g, /[。！？!?.]+["”』」)）]*\s*/g, /[，、；;,:：]\s*/g, /\s+/g];

/**
 * A line longer than the hub takes (MAX_CHAT, which it drops without a
 * receipt) as several lines of at most `max` characters, cut at the latest
 * paragraph, line, sentence, clause or space in each window (a hard cut only
 * when there is none), in order, nothing lost but the spaces at the cuts.
 */
export function splitChatText(text: string, max = MAX_CHAT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = 0;
    let next = 0;
    for (const re of CUTS) {
      // The latest break that keeps a part at least a quarter of the window.
      for (const m of window.matchAll(re)) {
        const end = m.index + m[0].length;
        const head = m.index + m[0].trimEnd().length;
        if (head > max || head < max / 4) continue;
        cut = head;
        next = end;
      }
      if (cut) break;
    }
    if (!cut) {
      cut = max;
      next = max;
    }
    const part = rest.slice(0, cut).trim();
    if (part) parts.push(part);
    rest = rest.slice(next).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Fields that vouch for the whole line's words (speaker proofs, the recheck): never on a part. */
const WHOLE_LINE_ONLY = ["speakerProof", "recheck", "continues", "timing", "stt"];

/**
 * One queued line, or the parts it is cut into when it is over MAX_CHAT. The
 * first keeps the id (a late receipt for it still lands); the others get
 * `<id>-2`, `<id>-3`… The page selection and files go with the first part only.
 */
export function splitOutgoing(item: OutgoingChat, max = MAX_CHAT): OutgoingChat[] {
  if (item.text.length <= max) return [item];
  const texts = splitChatText(item.text, max);
  return texts.map((text, i) => {
    const part: OutgoingChat = { ...item, id: i ? `${item.id.slice(0, 56)}-${i + 1}` : item.id, text };
    for (const k of WHOLE_LINE_ONLY) delete part[k];
    if (i) {
      delete part.context;
      delete part.attachments;
    }
    return part;
  });
}

function validQueue(stored: unknown): OutgoingChat[] {
  const queue: OutgoingChat[] = [];
  if (!Array.isArray(stored)) return queue;
  const seen = new Set<string>();
  for (const item of stored) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 128 ||
      typeof item.text !== "string" ||
      !item.text.trim() ||
      item.text.length > MAX_STORED ||
      seen.has(item.id)
    )
      continue;
    seen.add(item.id);
    const { rejected, ...message } = item;
    const long = message.text.length > MAX_CHAT;
    // A long line refused only for want of a receipt was dropped by the hub for
    // its length: cut into parts, it goes out after all.
    const reason =
      typeof rejected === "string" && rejected.trim() && !(long && rejected === NO_RECEIPT)
        ? { rejected }
        : {};
    // A line over MAX_CHAT (stored before lines were cut) goes out as its parts.
    for (const part of splitOutgoing(copy({ ...message, ...reason }) as OutgoingChat)) {
      if (part.id !== item.id && seen.has(part.id)) continue;
      seen.add(part.id);
      queue.push(part);
    }
  }
  return queue;
}

export function createChatOutbox(d: {
  read: () => unknown;
  write: (items: OutgoingChat[]) => void;
  readCursor?: () => unknown;
  writeCursor?: (seq: number) => void;
  send: (item: OutgoingChat) => boolean;
  id: () => string;
  onRejected: (item: OutgoingChat, reason: string) => void;
  onChange?: (items: OutgoingChat[]) => void;
  /** The store is shared with other tabs (localStorage): re-read it before each change. */
  shared?: boolean;
  /** Config `chat.outboxAckTimeoutMs`; 0 or absent = wait for a receipt forever. */
  ackTimeoutMs?: number | (() => number);
  /** Config `chat.outboxMaxResends`: resends before a line is marked `NO_RECEIPT`; 0 = never give up. */
  maxResends?: number | (() => number);
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}) {
  const setTimer = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    d.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const random = d.random ?? Math.random;
  let queue: OutgoingChat[] = [];
  try {
    queue = validQueue(d.read());
  } catch {}
  // The stored queue is shared with other tabs: re-read it before each change,
  // unless our own last write failed and memory is the only copy.
  let synced = true;
  const reload = () => {
    if (!d.shared || !synced) return;
    try {
      queue = validQueue(d.read());
    } catch {}
  };
  let cursor = 0;
  try {
    const stored = d.readCursor?.();
    if (typeof stored === "number" && Number.isSafeInteger(stored) && stored >= 0) cursor = stored;
  } catch {}
  const advance = (seq?: number) => {
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= cursor) return;
    cursor = seq;
    try {
      d.writeCursor?.(cursor);
    } catch {}
  };
  let ready = false;
  let flight: string | null = null;
  let disposed = false;
  let timer: unknown = null;
  /** Receipt timeouts since the last acknowledgement; doubles the next wait. */
  let misses = 0;
  const land = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    flight = null;
  };
  const positive = (value: number | (() => number) | undefined) => {
    try {
      const n = typeof value === "function" ? value() : value;
      return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };
  const timeoutMs = () => positive(d.ackTimeoutMs);
  const arm = (id: string) => {
    const base = timeoutMs();
    if (!base) return;
    const wait = base * Math.min(2 ** misses, ACK_BACKOFF_CAP);
    let jitter = 0;
    try {
      const r = random();
      if (Number.isFinite(r)) jitter = Math.min(Math.max(r, 0), 1) * ACK_JITTER;
    } catch {}
    timer = setTimer(
      () => {
        timer = null;
        if (disposed || flight !== id) return;
        const max = positive(d.maxResends);
        if (max && misses >= max) {
          // Stop holding the lines behind it; a late receipt still removes it.
          reject(id, NO_RECEIPT);
          return;
        }
        misses++;
        flight = null;
        // Another tab may have landed or refused it meanwhile.
        reload();
        flush();
      },
      Math.round(wait * (1 + jitter)),
    );
  };
  const reject = (id: string, reason: string) => {
    if (disposed || typeof reason !== "string" || !reason.trim()) return;
    reload();
    const item = queue.find((item) => item.id === id);
    if (!item || item.rejected) return;
    item.rejected = reason;
    if (flight === id) {
      land();
      misses = 0;
    }
    changed(true);
    d.onRejected(copy(item), reason);
    flush();
  };
  const changed = (notifyOnFailure = false) => {
    try {
      d.write(copy(queue));
    } catch {
      synced = false;
      if (notifyOnFailure) d.onChange?.(copy(queue));
      return false;
    }
    synced = true;
    d.onChange?.(copy(queue));
    return true;
  };
  const flush = () => {
    if (disposed || !ready || flight) return;
    const item = queue.find((entry) => !entry.rejected);
    if (!item) return;
    flight = item.id;
    try {
      if (d.send(copy(item))) {
        arm(item.id);
        return;
      }
    } catch {}
    flight = null;
    ready = false;
  };
  const acknowledge = (ids: readonly string[], seq?: number) => {
    if (disposed) return;
    advance(seq);
    reload();
    const accepted = new Set(ids);
    if (flight && accepted.has(flight)) {
      land();
      misses = 0;
    }
    const next = queue.filter((item) => !accepted.has(item.id));
    if (next.length !== queue.length) {
      queue = next;
      changed(true);
    }
    flush();
  };
  return {
    cursor: () => cursor,
    items: (): readonly OutgoingChat[] => copy(queue),
    enqueue(payload: OutgoingDraft) {
      if (disposed || !payload.text.trim()) return false;
      let item: OutgoingChat;
      try {
        item = copy({ ...payload, id: d.id() });
      } catch {
        return false;
      }
      delete item.rejected;
      reload();
      const wasSynced = synced;
      // Over MAX_CHAT the hub drops it with no receipt: it goes as several lines.
      const parts = splitOutgoing(item);
      queue.push(...parts);
      if (!changed()) {
        queue.splice(queue.length - parts.length, parts.length);
        synced = wasSynced;
        return false;
      }
      flush();
      return true;
    },
    ready(ids: readonly string[] = [], seq?: number) {
      if (disposed) return;
      // Reconcile authoritative history before any retry of an unacknowledged write.
      ready = false;
      land();
      acknowledge(ids, seq);
      ready = true;
      flush();
    },
    disconnect() {
      ready = false;
      land();
    },
    acknowledge,
    /** Another tab changed the stored queue (a `storage` event): show and send what it holds now. */
    refresh() {
      if (disposed) return;
      reload();
      if (flight && !queue.some((item) => item.id === flight && !item.rejected)) land();
      d.onChange?.(copy(queue));
      flush();
    },
    reject,
    dispose() {
      disposed = true;
      ready = false;
      land();
    },
  };
}

type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The queue used to live in sessionStorage (per tab). Move a tab's old lines
 * into the device's localStorage once, after any already there, so they are sent.
 */
export function migrateSessionOutbox(key: string, from: KeyStore, to: KeyStore): void {
  try {
    const raw = from.getItem(key);
    if (raw !== null) {
      const old = validQueue(JSON.parse(raw));
      let current: OutgoingChat[] = [];
      try {
        current = validQueue(JSON.parse(to.getItem(key) ?? "[]"));
      } catch {}
      const have = new Set(current.map((item) => item.id));
      const merged = [...current, ...old.filter((item) => !have.has(item.id))];
      if (merged.length !== current.length) to.setItem(key, JSON.stringify(merged));
      from.removeItem(key);
    }
    const rawCursor = from.getItem(`${key}:cursor`);
    if (rawCursor !== null) {
      const seq = JSON.parse(rawCursor);
      let had = 0;
      try {
        had = JSON.parse(to.getItem(`${key}:cursor`) ?? "0");
      } catch {}
      if (Number.isSafeInteger(seq) && seq > (Number.isSafeInteger(had) ? had : 0))
        to.setItem(`${key}:cursor`, JSON.stringify(seq));
      from.removeItem(`${key}:cursor`);
    }
  } catch {}
}

/** Merged voice parts retain the ids of every accepted client write. */
export function acknowledgedChatIds(
  messages: readonly { id: string; parts?: readonly { id: string }[] }[],
): string[] {
  return messages.flatMap((message) => [
    message.id,
    ...(message.parts?.map((part) => part.id) ?? []),
  ]);
}

/** New hubs also send legacy rate warnings; a recorded rejection already prompted once. */
export function hasChatRejection(items: readonly OutgoingChat[], id: unknown): boolean {
  return typeof id === "string" && items.some((item) => item.id === id && !!item.rejected);
}
