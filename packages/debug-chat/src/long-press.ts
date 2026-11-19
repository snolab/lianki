/**
 * A touch press held still for `ms` (a message's details on a phone, where
 * there is no right-click): `down` starts it, a move past `slopPx`, `up` or
 * `cancel` ends it, and `onLong` runs once if it was held long enough. After
 * it fired, `fired()` says so once, so the contextmenu a browser may send for
 * the same press (Android) is not taken twice. Timers are injected for tests.
 */
export const LONG_PRESS_MS = 500;
/** How far a finger may wander and still be "held still" (px). */
export const LONG_PRESS_SLOP_PX = 10;

export function createLongPress(d: {
  onLong: () => void;
  ms?: number;
  slopPx?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const slop = d.slopPx ?? LONG_PRESS_SLOP_PX;
  let timer: unknown = null;
  let start: { x: number; y: number } | null = null;
  let done = false;
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    start = null;
  };
  return {
    down(x: number, y: number) {
      stop();
      done = false;
      start = { x, y };
      timer = setTimer(() => {
        timer = null;
        start = null;
        done = true;
        d.onLong();
      }, d.ms ?? LONG_PRESS_MS);
    },
    move(x: number, y: number) {
      if (start && Math.hypot(x - start.x, y - start.y) > slop) stop();
    },
    /** The press ended (up, cancel, or the browser took it for a scroll). */
    cancel: stop,
    /** Did the last press fire? Read once. */
    fired() {
      const f = done;
      done = false;
      return f;
    },
  };
}
