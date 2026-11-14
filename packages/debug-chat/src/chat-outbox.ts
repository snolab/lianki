/** Per-account, per-tab delivery queue. A socket write is not an acknowledgement. */
export type OutgoingChat = { id: string; text: string; rejected?: string; [key: string]: unknown };
export type OutgoingDraft = { text: string; [key: string]: unknown };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function createChatOutbox(d: {
  read: () => unknown;
  write: (items: OutgoingChat[]) => void;
  readCursor?: () => unknown;
  writeCursor?: (seq: number) => void;
  send: (item: OutgoingChat) => boolean;
  id: () => string;
  onRejected: (item: OutgoingChat, reason: string) => void;
  onChange?: (items: OutgoingChat[]) => void;
}) {
  let queue: OutgoingChat[] = [];
  try {
    const stored = d.read();
    if (Array.isArray(stored)) {
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
    }
  } catch {}
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
  const changed = (notifyOnFailure = false) => {
    try {
      d.write(copy(queue));
    } catch {
      if (notifyOnFailure) d.onChange?.(copy(queue));
      return false;
    }
    d.onChange?.(copy(queue));
    return true;
  };
  const flush = () => {
    if (disposed || !ready || flight) return;
    const item = queue.find((entry) => !entry.rejected);
    if (!item) return;
    flight = item.id;
    try {
      if (d.send(copy(item))) return;
    } catch {}
    flight = null;
    ready = false;
  };
  const acknowledge = (ids: readonly string[], seq?: number) => {
    if (disposed) return;
    advance(seq);
    const accepted = new Set(ids);
    if (flight && accepted.has(flight)) flight = null;
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
      queue.push(item);
      if (!changed()) {
        queue.pop();
        return false;
      }
      flush();
      return true;
    },
    ready(ids: readonly string[] = [], seq?: number) {
      if (disposed) return;
      // Reconcile authoritative history before any retry of an unacknowledged write.
      ready = false;
      flight = null;
      acknowledge(ids, seq);
      ready = true;
      flush();
    },
    disconnect() {
      ready = false;
      flight = null;
    },
    acknowledge,
    reject(id: string, reason: string) {
      if (disposed || typeof reason !== "string" || !reason.trim()) return;
      const item = queue.find((item) => item.id === id);
      if (!item || item.rejected) return;
      item.rejected = reason;
      if (flight === id) flight = null;
      changed(true);
      d.onRejected(copy(item), reason);
      flush();
    },
    dispose() {
      disposed = true;
      ready = false;
      flight = null;
    },
  };
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
