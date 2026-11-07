/**
 * How far the chat is folded (the owner's fold redesign, 2026-11-04; the
 * storyboard is stories/chat-fold):
 *
 * - open: the bar and its log, as before;
 * - pill: the bar folded toward its mark into a pill, the mark still under the
 *   pointer. The mark and the pill's Li both open it again;
 * - tucked, the third level: slid into the screen edge, leaving one big
 *   handle. REMOVED for now (owner, 2026-11-07 20:32 JST: useless, to be
 *   rethought): nothing steps into it; a saved `tucked` shows the pill. Its
 *   handle code stays dormant (DebugChat.tsx tuckEl).
 *
 * `edge` is the screen edge the chat keeps to: on the left everything mirrors (the mark on the inner side, folding right,
 * the floating lines right-aligned to the pill). It follows the box after
 * each drag. Kept per device (localStorage `lk:pref:chat-fold`).
 */
import type { AnchorSide } from "./anchor";

export type Fold = "open" | "pill" | "tucked";
export type Edge = "left" | "right";
export type FoldState = { fold: Fold; edge: Edge };

export type FoldEvent =
  /** The mark's single tap: open ⇄ pill. */
  | { type: "mark" }
  /** The pill's Li, chat.open, the menu's Restore, a floating line's tap. */
  | { type: "restore" }
  /** The menu's Minimize. */
  | { type: "minimize" }
  /** A tap, or a press-and-drag, on the tucked handle or its peeking line. */
  | { type: "handle" }
  /** A drag ended: the box's nearest edge, and the edge the bar was pushed against (if any). */
  | { type: "dropped"; nearest: Edge; against: Edge | null };

export function foldNext(s: FoldState, ev: FoldEvent): FoldState {
  switch (ev.type) {
    case "mark":
      return { ...s, fold: s.fold === "open" ? "pill" : "open" };
    case "restore":
      return { ...s, fold: "open" };
    case "minimize":
      return s.fold === "open" ? { ...s, fold: "pill" } : s;
    case "handle":
      return s.fold === "tucked" ? { ...s, fold: "pill" } : s;
    case "dropped":
      // Pushed against an edge it just stays there (the tuck is removed).
      return { ...s, edge: ev.nearest };
  }
}

/** The screen edge nearest to a box spanning [left, right]: by its centre. */
export function nearestEdge(left: number, right: number, vw: number): Edge {
  return (left + right) / 2 < vw / 2 ? "left" : "right";
}

/**
 * The edge a dragged bar was pushed against: the drag keeps it on screen, so
 * pushed past an edge it rests flush with it (within half a pixel).
 */
export function pushedAgainst(left: number, right: number, vw: number): Edge | null {
  if (left <= 0.5) return "left";
  if (right >= vw - 0.5) return "right";
  return null;
}

/** Mirrored: on the left edge the bar's order and its fold run the other way. */
export const mirrored = (edge: Edge) => edge === "left";

/**
 * Where the minimized chat's floating lines align: from the pill's side, the
 * way the bar folded. At the right edge the bar folds left into a pill at its
 * left end, so the lines start at the pill's left edge; mirrored, they end at
 * its right edge. The screen third it sits in no longer matters.
 */
export const floatSide = (edge: Edge): AnchorSide => (mirrored(edge) ? "right" : "left");

/**
 * The box's horizontal shift that keeps a minimized pill where it is when the
 * edge (and so the mirroring) changes: the pill moves to the other end of the
 * box, so the box moves the other way by the difference of their widths.
 * Open, the bar spans the box and nothing moves.
 */
export function mirrorShift(d: {
  from: Edge;
  to: Edge;
  fold: Fold;
  boxWidth: number;
  pillWidth: number;
}): number {
  if (d.from === d.to || d.fold === "open") return 0;
  const gap = d.boxWidth - d.pillWidth;
  return d.to === "left" ? -gap : gap;
}

/**
 * The tucked handle. Two shapes the owner is choosing between (2026-11-04):
 * a half circle bulging from the edge, or a rounded square beside it. Switch
 * HANDLE_SHAPE to try the other one.
 */
export type HandleShape = "half" | "square";
export const HANDLE_SHAPE: HandleShape = "half";

/**
 * Sizes, px. Thumb-sized for a beginner: the touch area is at least the
 * 44 pt touch target the platforms recommend. On Android a horizontal swipe
 * that starts at the very edge is the system's Back, so the touch area
 * starts TOUCH_INSET in from the edge and reaches TOUCH_SLOP past the shape
 * inward: a tap, or a drag that starts on the handle, never a pull from the edge.
 */
export const HANDLE_SIZE: Record<HandleShape, { w: number; h: number; gap: number; r: string }> =
  {
    // A half circle: as tall as twice its bulge, flush with the edge.
    half: { w: 52, h: 104, gap: 0, r: "52px" },
    // A rounded square standing past the Back-gesture strip.
    square: { w: 60, h: 60, gap: 20, r: "18px" },
  };
/** Android keeps about this strip at the edge for its Back swipe (stories/chat-fold/handle.stories.ts). */
export const TOUCH_INSET = 20;
export const TOUCH_SLOP = 16;

/** The handle's touch area, px from its edge (inset) and its width. */
export function handleTouch(shape: HandleShape): { inset: number; width: number } {
  const s = HANDLE_SIZE[shape];
  return { inset: TOUCH_INSET, width: s.gap + s.w - TOUCH_INSET + TOUCH_SLOP };
}

/** The handle's top, px: centred on the pill's middle, kept inside the safe area. */
export function handleTop(d: {
  centerY: number;
  height: number;
  vh: number;
  safeTop?: number;
  safeBottom?: number;
}): number {
  const min = d.safeTop ?? 0;
  const max = d.vh - (d.safeBottom ?? 0) - d.height;
  const want = d.centerY - d.height / 2;
  return Math.round(max < min ? min : Math.min(max, Math.max(min, want)));
}
