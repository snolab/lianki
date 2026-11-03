import type { CSSProperties } from "react";

/**
 * The chat bar's geometry, as CSS variables on the bar, so the round controls
 * in its corners are concentric with its rounded border by construction.
 *
 * The nested-radius rule: an inner shape is concentric with its container
 * when inner radius = outer radius − the gap between their edges (border +
 * padding). Apple's iOS 26 shapes do the same (SwiftUI ConcentricRectangle,
 * containerShape). Here the inner shape is fixed (the mic's circle, one line
 * high), so the outer radius is derived from it:
 *
 *   --lk-bar-r       = border + padding + line / 2       (the bar's radius)
 *   --lk-bar-inner-r = --lk-bar-r − border − padding     (the circle's radius)
 *
 * The mic is pinned to the bar's inner bottom-right, a line-sized square, so
 * its centre is R from the right and from the bottom: the corner arc's centre.
 * One line high, the bar is exactly 2R tall, so the top-right arc shares it.
 * A taller draft grows the bar upward; the mic stays in the bottom arc.
 *
 * Unscaled by the text-size setting on purpose: only text scales (--lk-fs-k);
 * the line box, padding and border are rem and px, as the textarea's height
 * is. Checked by scripts/dev/debug-chat-concentric-qa.mjs.
 */
export const BAR_LINE = "2.125rem";
const BORDER = "1px";
/** Expanded, a little room around the input; minimized, tight. */
const PAD_OPEN = "0.125rem";
const PAD_MIN = "1px";

/*
 * Inline styles, not new Tailwind classes: a class the page's stylesheet has
 * not generated yet (a dev server's stale CSS, a hot widget on an older page)
 * would leave the bar with no radius and no border (2026-11-03, preview).
 */

/** The bar: its variables, and the radius, border and padding drawn from them. */
export function barGeometry(open: boolean): CSSProperties {
  return {
    "--lk-bar-b": BORDER,
    "--lk-bar-pad": open ? PAD_OPEN : PAD_MIN,
    "--lk-bar-line": BAR_LINE,
    "--lk-bar-r": "calc(var(--lk-bar-b) + var(--lk-bar-pad) + var(--lk-bar-line) / 2)",
    "--lk-bar-inner-r": "calc(var(--lk-bar-r) - var(--lk-bar-b) - var(--lk-bar-pad))",
    borderStyle: "solid",
    borderWidth: "var(--lk-bar-b)",
    borderRadius: "var(--lk-bar-r)",
    padding: "var(--lk-bar-pad)",
  } as CSSProperties;
}

/** A control in the bar: one line box high, so it is centred on one line. */
export const BAR_CONTROL: CSSProperties = { height: `var(--lk-bar-line, ${BAR_LINE})` };

/**
 * The mic: 40px wide to the touch, its circle the line-sized square at its
 * end (the start padding takes the rest), in the bar's corner.
 */
export const MIC_BOX = {
  "--lk-mic-w": "2.5rem",
  "--lk-mic-ring": "3px",
  width: "var(--lk-mic-w)",
  height: `var(--lk-bar-line, ${BAR_LINE})`,
  paddingInlineStart: `calc(var(--lk-mic-w) - var(--lk-bar-line, ${BAR_LINE}))`,
  borderRadius: `var(--lk-bar-inner-r, calc(${BAR_LINE} / 2))`,
} as CSSProperties;

/** A ring on the mic's circle, inset by --lk-mic-ring: concentric with it, so with the bar. */
export const MIC_RING: CSSProperties = {
  top: "var(--lk-mic-ring)",
  bottom: "var(--lk-mic-ring)",
  insetInlineEnd: "var(--lk-mic-ring)",
  insetInlineStart: `calc(var(--lk-mic-w) - var(--lk-bar-line, ${BAR_LINE}) + var(--lk-mic-ring))`,
};
