/**
 * Dragging the chat box without React (owner, 2026-11-14 21:0x JST: the drag
 * felt janky; every pointermove re-rendered the whole chat). During a drag the
 * box's transform is written straight to the element, at most once per frame;
 * React hears the position once, when the finger lets go (DebugChat.tsx useDrag).
 *
 * Pure parts here, so they are tested without a browser:
 * - createFrameWriter: many pushes in a frame, one write with the latest value.
 * - dragStep: where the box goes for a pointer delta, from geometry measured
 *   once per drag (no layout reads per move).
 * - createGapMeter: the gaps between drag frames, for the debug perf log.
 */

/** requestAnimationFrame, injectable for tests. */
export type FrameClock = {
  request: (cb: (t: number) => void) => number;
  cancel: (id: number) => void;
  now: () => number;
};

const browserClock: FrameClock = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
};

/**
 * Coalesce values into one `apply` per animation frame, with the latest value.
 * `flush` applies a pending value now (the drag's last point on pointerup);
 * `cancel` drops it.
 */
export function createFrameWriter<T>(apply: (v: T, t: number) => void, clock = browserClock) {
  let id: number | null = null;
  let has = false;
  let value: T | undefined;
  const run = (t: number) => {
    id = null;
    if (!has) return;
    const v = value as T;
    has = false;
    value = undefined;
    apply(v, t);
  };
  return {
    push(v: T) {
      value = v;
      has = true;
      if (id === null) id = clock.request(run);
    },
    flush() {
      if (id !== null) clock.cancel(id);
      id = null;
      if (has) run(clock.now());
    },
    cancel() {
      if (id !== null) clock.cancel(id);
      id = null;
      has = false;
      value = undefined;
    },
    pending: () => has,
  };
}

/**
 * The bar (the input row) and the box at the drag's start offset, viewport px,
 * plus the viewport: measured once per drag. `top` is the bar's resting top
 * (the keyboard lift added back: it is transient and never saved).
 */
export type DragGeom = {
  left: number;
  top: number;
  width: number;
  height: number;
  boxLeft: number;
  boxRight: number;
  vw: number;
  vh: number;
  safeTop: number;
};

/** Where a drag leaves the bar and its box (DebugChat.tsx DropSpan). */
export type DragSpan = {
  left: number;
  right: number;
  boxLeft: number;
  boxRight: number;
  bottom: number;
};

/**
 * The box's offset for a pointer delta (dx, dy) from the drag's start offset
 * (x0, y0): the bar kept on screen, up to the very top under the notch. The
 * click-through log above it may go off-screen.
 */
export function dragStep(
  g: DragGeom,
  start: { x: number; y: number },
  dx: number,
  dy: number,
): { x: number; y: number; span: DragSpan } {
  const mx = Math.max(-g.left, Math.min(g.vw - g.width - g.left, dx));
  const my = Math.max(g.safeTop - g.top, Math.min(g.vh - g.height - g.top, dy));
  return {
    x: start.x + mx,
    y: start.y + my,
    span: {
      left: g.left + mx,
      right: g.left + mx + g.width,
      boxLeft: g.boxLeft + mx,
      boxRight: g.boxRight + mx,
      bottom: g.top + my + g.height,
    },
  };
}

/** The box's transform for an offset: the keyboard lift stays a CSS variable. */
export function dragTransform(x: number, y: number, liftVar: string) {
  return `translate3d(${x}px, calc(${y}px - var(${liftVar}, 0px)), 0)`;
}

/** The gaps between drag frames, ms: max and p95 (the debug perf log). */
export function createGapMeter() {
  let last: number | null = null;
  const gaps: number[] = [];
  return {
    frame(t: number) {
      if (last !== null) gaps.push(t - last);
      last = t;
    },
    report() {
      const s = [...gaps].sort((a, b) => a - b);
      const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0);
      return { frames: gaps.length + (last === null ? 0 : 1), max: s.at(-1) ?? 0, p95: at(0.95) };
    },
  };
}

/** The debug perf log is on (localStorage `lk:drag-perf` = "1"; a dev switch, never shown). */
export const DRAG_PERF_KEY = "lk:drag-perf";
