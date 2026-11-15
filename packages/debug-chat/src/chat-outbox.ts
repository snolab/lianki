/**
 * Per-account delivery queue, durable on the device (docs/dev-debug-widget.md,
 * "Pending input and durable chat acceptance"). A socket write is not an
 * acknowledgement: an entry with no receipt within `ackTimeoutMs` is sent again
 * under the same id (the hub de-duplicates by id), backing off up to
 * `ACK_BACKOFF_CAP`× the timeout until the next receipt.
 */
export type OutgoingChat = { id: string; text: string; rejected?: string; [key: string]: unknown };
export type OutgoingDraft = { text: string; [key: string]: unknown };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** Largest multiple of the receipt timeout between resends of an unacknowledged line. */
export const ACK_BACKOFF_CAP = 8;
/** The local refusal reason of a line resent `maxResends` times with no receipt. */
export const NO_RECEIPT = "no-receipt";
/** Up to this share of the wait is added at random, so two tabs do not resend in lockstep. */
const ACK_JITTER = 0.25;

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
      item.text.length > 20_000 ||
      seen.has(item.id)
    )
      continue;
    seen.add(item.id);
    const { rejected, ...message } = item;
    queue.push(
      copy({
        ...message,
        ...(typeof rejected === "string" && rejected.trim() ? { rejected } : {}),
      }),
    );
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
      queue.push(item);
      if (!changed()) {
        queue.pop();
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
