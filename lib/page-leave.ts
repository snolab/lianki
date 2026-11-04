/**
 * The system can take a touch away, or the page itself, at any moment:
 * Android's edge Back (a sideways drag from either screen edge), iOS's edge
 * swipe back, the notification shade, an app switch. A web page can't
 * cancel any of them (docs/design-principles.md, "Edge gestures").
 *
 * `onPageLeave(fn)` calls `fn` once for each sign that it happened while
 * something was in hand: the page hidden (`visibilitychange` → hidden),
 * `pagehide`, history moved (`popstate`, which is the Back itself on a
 * same-page entry or a Next.js client navigation), and, with `blur`, the
 * window losing focus. Callers use it to end a gesture with no grade
 * (lib/words/swipe-core.tsx, lib/words/native-slip-gesture.ts) and to write
 * a debounced position now rather than lose it (/words anchors, /read).
 *
 * Returns the detach. Pure DOM wiring: the targets are parameters, so a test
 * passes plain EventTargets.
 */
export type LeaveReason = "hidden" | "pagehide" | "popstate" | "blur";

export type LeaveTargets = {
  win: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  doc: Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
    visibilityState: string;
  };
};

export function onPageLeave(
  fn: (why: LeaveReason) => void,
  opts: { blur?: boolean } & Partial<LeaveTargets> = {},
): () => void {
  // Callers run in effects and event handlers: always in a browser.
  const win = opts.win ?? window;
  const doc = opts.doc ?? document;
  const hidden = () => doc.visibilityState === "hidden" && fn("hidden");
  const pagehide = () => fn("pagehide");
  const popstate = () => fn("popstate");
  const blur = () => fn("blur");
  doc.addEventListener("visibilitychange", hidden);
  win.addEventListener("pagehide", pagehide);
  win.addEventListener("popstate", popstate);
  if (opts.blur) win.addEventListener("blur", blur);
  return () => {
    doc.removeEventListener("visibilitychange", hidden);
    win.removeEventListener("pagehide", pagehide);
    win.removeEventListener("popstate", popstate);
    win.removeEventListener("blur", blur);
  };
}
