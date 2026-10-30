/**
 * "Joystick mode" for the full-screen log (a drag that began on the empty
 * input): held in a band at the top or bottom edge of the visible area, the
 * finger keeps the log scrolling that way, faster the deeper into the band.
 * Leaving the band, or lifting, stops it.
 *
 * Direction follows the drag: the finger going down scrolls back (older
 * lines), so the bottom edge keeps scrolling back and the top edge forward.
 *
 * A drag starts on the bar, inside the bottom band already: that band arms
 * only once the finger has been above it, so the log does not run off the
 * moment the drag begins.
 */
export const EDGE_ZONE_PX = 72;
/** At the very edge: px per second. */
export const EDGE_MAX_SPEED = 1800;
/** Under reduced motion: slower, and linear in depth. */
export const EDGE_MAX_SPEED_REDUCED = 600;

export type EdgeState = { bottomArmed: boolean };

/**
 * The scroll speed (px/s, signed as scrollTop changes: negative = back) for
 * a finger at `y` in a visible area [top, bottom], and the next state.
 */
export function edgeSpeed(
  y: number,
  area: { top: number; bottom: number },
  state: EdgeState,
  opts: { zone?: number; reduced?: boolean } = {},
): { speed: number; state: EdgeState } {
  const zone = opts.zone ?? EDGE_ZONE_PX;
  const max = opts.reduced ? EDGE_MAX_SPEED_REDUCED : EDGE_MAX_SPEED;
  const ease = (depth: number) => {
    const t = Math.min(1, Math.max(0, depth / zone));
    return opts.reduced ? t : t * t;
  };
  const bottomArmed = state.bottomArmed || y < area.bottom - zone;
  const next = { bottomArmed };
  if (y < area.top + zone) return { speed: max * ease(area.top + zone - y), state: next };
  if (bottomArmed && y > area.bottom - zone)
    return { speed: -max * ease(y - (area.bottom - zone)), state: next };
  return { speed: 0, state: next };
}

type Frames = {
  request: (cb: (t: number) => void) => number;
  cancel: (id: number) => void;
};

/**
 * One rAF loop that scrolls by `speed` px/s while it is non-zero: `set`
 * starts or stops it, `dispose` cancels any frame for good (release, unmount).
 */
export function createJoystick(
  scrollBy: (px: number) => void,
  frames: Frames = {
    request: (cb) => requestAnimationFrame(cb),
    cancel: (id) => cancelAnimationFrame(id),
  },
) {
  let speed = 0;
  let id: number | null = null;
  let last: number | null = null;
  let disposed = false;
  const tick = (t: number) => {
    id = null;
    if (disposed || speed === 0) return;
    // The first frame only takes the time; at most 50 ms per step (a stalled tab).
    if (last !== null) scrollBy((speed * Math.min(50, t - last)) / 1000);
    last = t;
    id = frames.request(tick);
  };
  return {
    set(next: number) {
      if (disposed) return;
      speed = next;
      if (speed === 0) {
        if (id !== null) frames.cancel(id);
        id = null;
        last = null;
      } else if (id === null) id = frames.request(tick);
    },
    /** A frame is waiting (for tests and the dispose check). */
    running: () => id !== null,
    dispose() {
      disposed = true;
      speed = 0;
      if (id !== null) frames.cancel(id);
      id = null;
    },
  };
}
