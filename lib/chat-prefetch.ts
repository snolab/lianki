/**
 * Fetch the chat's code in idle time right after first paint, so it is there
 * when the hub's socket opens (docs/cold-start.md, "The chat at once").
 * The chat itself still loads with React.lazy (DebugEval.tsx); this only warms
 * the same module, once per page, and only for a viewer who will see it.
 */

/**
 * Who gets the prefetch: a signed-in viewer (the server rendered the page with
 * a session) whose chat is wanted — the Learning Partner open to them, or this
 * device in debug mode. Never a guest: their chat never opens.
 */
export function chatPrefetchWanted(v: {
  account: string | null | undefined;
  partnerOpen: boolean;
  debug: boolean;
}): boolean {
  return !!v.account && (v.partnerOpen || v.debug);
}

type IdleWin = {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (id: never) => void;
};

/** Without requestIdleCallback (Safari), this long after mount. */
export const PREFETCH_FALLBACK_MS = 200;
/** requestIdleCallback's deadline: a busy page still gets it this soon. */
export const PREFETCH_IDLE_TIMEOUT_MS = 1500;

let started = false;

/**
 * Run `load` once, when the page is idle (requestIdleCallback, else a short
 * timeout). Returns a cancel for an unmount before it ran. A failure is
 * ignored: React.lazy loads it again when shown.
 */
export function prefetchWhenIdle(load: () => Promise<unknown>, win: IdleWin): () => void {
  if (started) return () => {};
  const run = () => {
    if (started) return;
    started = true;
    void load().catch(() => {
      started = false;
    });
  };
  if (win.requestIdleCallback) {
    const id = win.requestIdleCallback(run, { timeout: PREFETCH_IDLE_TIMEOUT_MS });
    return () => win.cancelIdleCallback?.(id);
  }
  const t = win.setTimeout(run, PREFETCH_FALLBACK_MS);
  return () => win.clearTimeout(t as never);
}

/** Tests only: forget that the prefetch ran. */
export function resetChatPrefetch(): void {
  started = false;
}
