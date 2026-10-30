/**
 * "Joystick mode" for the full-screen log (a drag that began on the empty
 * input), like a touchpad's: a dead zone, a circle, is centred where the
 * finger pressed. Inside it the drag scrolls the log as usual. Outside it
 * the log keeps scrolling that way on its own, faster the further out the
 * finger is, and stops when the finger comes back inside (or lifts). The
 * screen's edges play no part.
 *
 * Direction follows the drag: the finger below the press point scrolls back
 * (older lines), above it forward. Only the vertical part counts.
 */
export type JoystickTune = {
  /** The dead zone's radius, px. */
  radius: number;
  /** Past the zone, the distance over which the speed ramps up to its max, px. */
  ramp: number;
  /** The top speed, px per second (and under reduced motion, linear). */
  max: number;
  maxReduced: number;
};
/**
 * The defaults, tunable: edit them here with the widget hot-loaded, or set
 * `globalThis.__lkJoystickTune = { radius: 48 }` on the page (read at each
 * press) to try a value without a rebuild.
 */
export const JOYSTICK_TUNE: JoystickTune = { radius: 40, ramp: 140, max: 1800, maxReduced: 600 };

/** The defaults with the page's overrides (only finite, positive numbers count). */
export function joystickTune(
  over: unknown = (globalThis as { __lkJoystickTune?: unknown }).__lkJoystickTune,
): JoystickTune {
  const t = { ...JOYSTICK_TUNE };
  if (over && typeof over === "object")
    for (const k of Object.keys(t) as (keyof JoystickTune)[]) {
      const v = (over as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) t[k] = v;
    }
  return t;
}

/**
 * Where the finger is against the dead zone around the press point:
 * `inside`, or the scroll speed (px/s, signed as scrollTop changes:
 * negative = back) outside it.
 */
export function deadZoneSpeed(
  dx: number,
  dy: number,
  tune: JoystickTune = JOYSTICK_TUNE,
  reduced = false,
): { inside: boolean; speed: number } {
  const dist = Math.hypot(dx, dy);
  if (dist <= tune.radius) return { inside: true, speed: 0 };
  const t = Math.min(1, (dist - tune.radius) / tune.ramp);
  const ease = reduced ? t : t * t;
  const max = reduced ? tune.maxReduced : tune.max;
  // The vertical share of the push; the finger going down scrolls back.
  return { inside: false, speed: -max * ease * (dy / dist) };
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
