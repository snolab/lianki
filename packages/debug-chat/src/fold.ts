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
  /** A drag ended freely: the box's nearest edge (drop zones: snap-targets.ts). */
  | { type: "dropped"; nearest: Edge };

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
      // It stays where it was dropped, keeping to its nearest edge (the tuck is removed).
      return { ...s, edge: ev.nearest };
  }
}

/** The screen edge nearest to a box spanning [left, right]: by its centre. */
export function nearestEdge(left: number, right: number, vw: number): Edge {
  return (left + right) / 2 < vw / 2 ? "left" : "right";
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

