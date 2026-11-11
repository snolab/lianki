// Multiplex only an already-authorized grant stream. Public tokens remain own-scope.
export const INBOX_DEFAULTS = { maxThreads: 64, idleTtlMs: 1800000 };

/** @param {{createReceiver: (thread: string) => any, config?: Record<string,number>, now?: () => number}} options */
export function createFriendInbox({ createReceiver, config = {}, now = Date.now }) {
  const cfg = { ...INBOX_DEFAULTS, ...config };
  const threads = new Map();
  const valid = (thread) => typeof thread === "string" && thread !== "owner" && /^[A-Za-z0-9_-]{1,64}$/.test(thread);
  function receiver(thread) {
    for (const [id, entry] of threads) {
      if (!entry.active && !entry.receiver.pending() && now() - entry.at >= cfg.idleTtlMs) {
        entry.receiver.stop(); threads.delete(id);
      }
    }
    let entry = threads.get(thread);
    if (!entry) {
      if (threads.size >= cfg.maxThreads) throw Error("friend thread capacity reached; split the authorized input stream");
      entry = { receiver: createReceiver(thread), at: now(), active: 0 };
      threads.set(thread, entry);
    }
    return entry;
  }
  return {
    async accept(event) {
      if (event.type === "history") {
        const groups = new Map();
        for (const m of event.messages ?? []) {
          if (!valid(m.thread) || !["friend", "agent"].includes(m.from)) continue;
          const list = groups.get(m.thread) ?? [];
          list.push(m); groups.set(m.thread, list);
        }
        for (const [thread, messages] of groups) await this.accept({ type: "thread-history", thread, messages });
        return;
      }
      const m = event.type === "chat" ? event.message ?? event : event;
      if (!valid(m.thread)) return;
      if (event.type === "chat" && !["friend", "agent"].includes(m.from)) return;
      if (!["chat", "edited", "answered", "thread-history"].includes(event.type)) return;
      const entry = receiver(m.thread);
      entry.at = now(); entry.active++;
      try { await entry.receiver.accept(event.type === "thread-history" ? { type: "history", messages: event.messages } : event); }
      finally { entry.active--; }
    },
    async finish() { await Promise.all([...threads.values()].map((entry) => entry.receiver.finish())); },
    stop() { for (const entry of threads.values()) entry.receiver.stop(); threads.clear(); },
  };
}
