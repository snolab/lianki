/**
 * Delete with Undo, for the /words list picker: the row disappears at once,
 * an Undo toast shows, and the server only hears of it when the toast runs
 * out. The server's delete is final (a list's cards and reviews go with it),
 * so the undo window is kept on the client instead of in the data.
 *
 * One delete waits at a time: a second one sends the first straight away.
 * The page sends a waiting delete when it goes away (`flush("leave")`, with
 * fetch keepalive), so closing the tab does not quietly keep the list.
 */

/** How long Undo is offered, ms. */
export const UNDO_MS = 8000;

/** "timeout": the toast ran out; "next": another delete; "leave": the page is going away. */
export type FlushReason = "timeout" | "next" | "leave";

export type DeferredDelete<T> = {
  /** What is waiting to be deleted, or null. */
  current(): T | null;
  /** Hide `item` now and delete it after the delay. */
  remove(item: T): void;
  /** Cancel the waiting delete; returns what was restored. */
  undo(): T | null;
  /** Send the waiting delete now. */
  flush(reason: FlushReason): void;
};

export function createDeferredDelete<T>(opts: {
  commit: (item: T, reason: FlushReason) => void | Promise<void>;
  /** Called whenever `current()` changes. */
  onChange: (current: T | null) => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): DeferredDelete<T> {
  const delay = opts.delayMs ?? UNDO_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let waiting: { item: T; timer: unknown } | null = null;

  const take = (): T | null => {
    if (!waiting) return null;
    clearTimer(waiting.timer);
    const { item } = waiting;
    waiting = null;
    return item;
  };
  const flush = (reason: FlushReason) => {
    const item = take();
    if (item === null) return;
    if (reason !== "next") opts.onChange(null);
    void opts.commit(item, reason);
  };

  return {
    current: () => waiting?.item ?? null,
    remove(item) {
      flush("next");
      waiting = { item, timer: setTimer(() => flush("timeout"), delay) };
      opts.onChange(item);
    },
    undo() {
      const item = take();
      if (item !== null) opts.onChange(null);
      return item;
    },
    flush,
  };
}
