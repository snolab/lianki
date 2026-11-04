/**
 * Where the minimized chat's floating box (its floating lines, the frontier,
 * the tree) goes: on the pill's side (fold.ts floatSide). "left": the box's
 * left edge on the pill's; "right": right edges together; "center": centred
 * on it. Always inside the viewport less the safe areas and an 8px gutter.
 */
export type AnchorSide = "left" | "center" | "right";
export const ANCHOR_GUTTER_PX = 8;

/** The box's left edge (viewport px) for its width, anchored to the bar and clamped. */
export function placeBox(d: {
  side: AnchorSide;
  barLeft: number;
  barRight: number;
  boxWidth: number;
  vw: number;
  insetLeft?: number;
  insetRight?: number;
  gutter?: number;
}): { side: AnchorSide; left: number } {
  const g = d.gutter ?? ANCHOR_GUTTER_PX;
  const { side } = d;
  const want =
    side === "left"
      ? d.barLeft
      : side === "right"
        ? d.barRight - d.boxWidth
        : (d.barLeft + d.barRight) / 2 - d.boxWidth / 2;
  const min = (d.insetLeft ?? 0) + g;
  const max = d.vw - (d.insetRight ?? 0) - g - d.boxWidth;
  // Too wide to fit at all: pinned to the left gutter.
  return { side, left: Math.round(max < min ? min : Math.min(max, Math.max(min, want))) };
}
