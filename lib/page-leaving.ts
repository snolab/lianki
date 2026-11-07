/**
 * Whether this document has started to leave: a reload, a link to another
 * page, the tab closing. For requests that only matter while the page stays.
 *
 * WebKit refuses a fetch the old page starts while the next page is loading
 * and reports it as a page error ("<url> due to access control checks."),
 * caught or not; under load that stretch lasts seconds, and timers and React
 * effects keep running through it. `pagehide` comes too late (WebKit has cut
 * the page's loads by then), so this listens to `beforeunload`, the first
 * event of a leave. It stays left until the person is back: a leave can be
 * called off (a "Leave page?" prompt), and then the next pointer or key, or a
 * page restored from the back/forward cache, makes the page present again.
 *
 * `watch()` is held while a caller cares; the listeners are there only while
 * it is held.
 */
type Target = Pick<Window, "addEventListener" | "removeEventListener">;

const BACK = ["pointerdown", "keydown", "pageshow"] as const;

export function createLeaving(win: Target) {
  let ctrl = new AbortController();
  let holders = 0;
  const leave = () => ctrl.abort();
  const back = () => {
    if (ctrl.signal.aborted) ctrl = new AbortController();
  };
  const opts = { capture: true, passive: true } as const;
  return {
    /**
     * Aborted from beforeunload until the person is back: start nothing on an
     * aborted one, and pass it to a request so a leave cuts it.
     */
    get signal(): AbortSignal {
      return ctrl.signal;
    },
    /** Listen while held; the returned function lets go. */
    watch(): () => void {
      if (holders++ === 0) {
        win.addEventListener("beforeunload", leave, opts);
        for (const t of BACK) win.addEventListener(t, back, opts);
      }
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        if (--holders > 0) return;
        win.removeEventListener("beforeunload", leave, opts);
        for (const t of BACK) win.removeEventListener(t, back, opts);
        back();
      };
    },
  };
}

let shared: ReturnType<typeof createLeaving> | null = null;
/** This window's leaving state (the browser only). */
export function pageLeaving(): ReturnType<typeof createLeaving> {
  shared ??= createLeaving(window);
  return shared;
}
