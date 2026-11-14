/**
 * Double-tap, then drag to zoom (owner, 2026-11-15: "触屏双击并拖动是放大缩小…
 * PC端不遵循这个行为… pointer devices 有这个行为，但是鼠标没有"), as maps do:
 * a tap, then within `gapMs` a second finger (or pen) down near it; if that
 * second pointer moves, its vertical travel zooms the time scale about the
 * point under it (down = in, up = out). A second tap that does not move stays
 * a plain tap. Touch and pen only: a mouse never arms it (double-click is
 * unchanged). A second pointer at any time (a pinch) cancels it.
 *
 * Pure: the view feeds pointer events in and applies what comes out.
 */

/** The gesture's thresholds (ms, client px, zoom per px). Data, not scattered constants. */
export const DBLTAP = {
  /** The first tap: down to up within this long… */
  tapMs: 300,
  /** …and moving at most this far, else it was a pan. */
  tapMovePx: 10,
  /** The second down comes within this long of the first tap's up… */
  gapMs: 300,
  /** …and this close to it. */
  slopPx: 24,
  /** The second pointer moves this far before it zooms (below: still a tap). */
  dragPx: 6,
  /** Zoom factor per px of vertical travel: exp(dy · zoomPerPx), down = in. */
  zoomPerPx: 0.01,
} as const;

export type DbltapConfig = { readonly [K in keyof typeof DBLTAP]: number };

/** One pointer event as the machine reads it (client px, ms). */
export type DbltapPointer = {
  id: number;
  type: string;
  x: number;
  y: number;
  t: number;
};

export type DbltapState =
  | { kind: "idle" }
  /** The first pointer is down: maybe a tap. */
  | { kind: "first"; id: number; x: number; y: number; t: number }
  /** A tap ended: a second down near it soon arms the gesture. */
  | { kind: "armed"; x: number; y: number; t: number }
  /** The second pointer is down, not moved yet: still a plain tap. */
  | { kind: "second"; id: number; x: number; y: number }
  /** Dragging: the zoom is live, from where the second pointer went down. */
  | { kind: "zoom"; id: number; x0: number; y0: number };

export type DbltapOut =
  /** The zoom starts: anchor the time under (x, y). */
  | { type: "start"; x: number; y: number }
  /** The whole factor so far (absolute from the start) and the pointer's x now. */
  | { type: "zoom"; factor: number; x: number }
  /** The zoom ended (release, cancel or a second pointer). */
  | { type: "end" };

export type DbltapStep = { state: DbltapState; out?: DbltapOut };

export const DBLTAP_IDLE: DbltapState = { kind: "idle" };

/** Touch and pen only: a mouse (or anything else) never takes part. */
export const dbltapPointer = (type: string) => type === "touch" || type === "pen";

const far = (ax: number, ay: number, bx: number, by: number, px: number) =>
  Math.hypot(ax - bx, ay - by) > px;

/** The zoom factor for a vertical travel of dy px (down positive = in). */
export const dbltapFactor = (dy: number, cfg: DbltapConfig = DBLTAP) => Math.exp(dy * cfg.zoomPerPx);

/** Ends a live zoom (with "end"), else just drops back to idle. */
const reset = (s: DbltapState): DbltapStep =>
  s.kind === "zoom" ? { state: DBLTAP_IDLE, out: { type: "end" } } : { state: DBLTAP_IDLE };

export function dbltapDown(s: DbltapState, p: DbltapPointer, cfg: DbltapConfig = DBLTAP): DbltapStep {
  if (!dbltapPointer(p.type)) return { state: s };
  // A pointer while one is already down: a pinch, which takes precedence.
  if (s.kind === "first" || s.kind === "second" || s.kind === "zoom") return reset(s);
  if (s.kind === "armed" && p.t - s.t <= cfg.gapMs && !far(p.x, p.y, s.x, s.y, cfg.slopPx))
    return { state: { kind: "second", id: p.id, x: p.x, y: p.y } };
  return { state: { kind: "first", id: p.id, x: p.x, y: p.y, t: p.t } };
}

export function dbltapMove(s: DbltapState, p: DbltapPointer, cfg: DbltapConfig = DBLTAP): DbltapStep {
  if (!dbltapPointer(p.type)) return { state: s };
  if (s.kind === "first" && s.id === p.id && far(p.x, p.y, s.x, s.y, cfg.tapMovePx))
    return { state: DBLTAP_IDLE }; // a pan, not a tap
  if (s.kind === "second" && s.id === p.id) {
    if (!far(p.x, p.y, s.x, s.y, cfg.dragPx)) return { state: s };
    const state: DbltapState = { kind: "zoom", id: p.id, x0: s.x, y0: s.y };
    return { state, out: { type: "start", x: s.x, y: s.y } };
  }
  if (s.kind === "zoom" && s.id === p.id)
    return { state: s, out: { type: "zoom", factor: dbltapFactor(p.y - s.y0, cfg), x: p.x } };
  return { state: s };
}

export function dbltapUp(s: DbltapState, p: DbltapPointer, cfg: DbltapConfig = DBLTAP): DbltapStep {
  if (!dbltapPointer(p.type)) return { state: s };
  if (s.kind === "first" && s.id === p.id)
    return p.t - s.t <= cfg.tapMs && !far(p.x, p.y, s.x, s.y, cfg.tapMovePx)
      ? { state: { kind: "armed", x: s.x, y: s.y, t: p.t } }
      : { state: DBLTAP_IDLE };
  if ((s.kind === "second" || s.kind === "zoom") && s.id === p.id) return reset(s);
  return { state: s };
}

/** pointercancel (or the view going away): whatever was under way ends. */
export const dbltapCancel = (s: DbltapState): DbltapStep => reset(s);

/**
 * The browser must not pan the second pointer: true while a second down
 * would arm the gesture (armed, within the gap) or the gesture holds a pointer.
 */
export const dbltapHolds = (s: DbltapState, t: number, cfg: DbltapConfig = DBLTAP) =>
  s.kind === "second" || s.kind === "zoom" || (s.kind === "armed" && t - s.t <= cfg.gapMs);
