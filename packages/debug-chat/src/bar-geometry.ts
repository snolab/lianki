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
 * The mic sits in one cluster with the mark and the + (owner, 2026-11-07:
 * "我们把麦克风跟另外几个按钮排到一起吧……这样折叠的时候，它位置就不会变"):
 * [mark | + | mic | input] open and [mark | Li | mic] folded, every slot
 * CONTROL_W wide and the padding the same in both, so the mic keeps its place.
 * Folded, the mic is the pill's last control: its circle, a line-sized square
 * at its end, is R from the right and from the bottom, the corner arc's
 * centre. One line high, the bar is exactly 2R tall, so the top-right arc
 * shares it. Open, it is the same circle at the same place, beside the input.
 *
 * Unscaled by the text-size setting on purpose: only text scales (--lk-fs-k);
 * the line box, padding and border are rem and px, as the textarea's height
 * is. Checked by scripts/dev/debug-chat-concentric-qa.mjs.
 */
export const BAR_LINE = "2.125rem";
const BORDER = "1px";
/**
 * A little room around the input, the same open and folded: the tighter pill
 * it had moved the mark and the mic by a pixel when the chat folded.
 */
const PAD = "0.125rem";
/** Each control of the bar's cluster (mark, +, the pill's Li, mic): 44 px, the platforms' touch target. */
export const CONTROL_W = "2.75rem";
/** Open, where the input starts in the bar: after the cluster [mark | + | mic]. */
export const INPUT_START = `calc(3 * ${CONTROL_W})`;

/*
 * Inline styles, not new Tailwind classes: a class the page's stylesheet has
 * not generated yet (a dev server's stale CSS, a hot widget on an older page)
 * would leave the bar with no radius and no border (2026-11-03, preview).
 */

/** The bar: its variables, and the radius, border and padding drawn from them. */
export function barGeometry(): CSSProperties {
  return {
    "--lk-bar-b": BORDER,
    "--lk-bar-pad": PAD,
    "--lk-bar-line": BAR_LINE,
    "--lk-bar-r": "calc(var(--lk-bar-b) + var(--lk-bar-pad) + var(--lk-bar-line) / 2)",
    "--lk-bar-inner-r": "calc(var(--lk-bar-r) - var(--lk-bar-b) - var(--lk-bar-pad))",
    borderStyle: "solid",
    borderWidth: "var(--lk-bar-b)",
    borderRadius: "var(--lk-bar-r)",
    padding: "var(--lk-bar-pad)",
  } as CSSProperties;
}

/**
 * A control in the bar: one line box high, so it is centred on one line, and
 * CONTROL_W wide, never shrunk, so the cluster is as wide folded as open.
 */
export const BAR_CONTROL: CSSProperties = {
  height: `var(--lk-bar-line, ${BAR_LINE})`,
  width: CONTROL_W,
  flexShrink: 0,
};

/**
 * The bar controls' touch area: 44 px high as well, a little past the bar's
 * 40 px edge (their widths are CONTROL_W). Its own <style>, not a Tailwind
 * class, so a stale stylesheet or another site's page has it too; it outranks
 * the app's 40 px `.tap-40`. The controls carry `data-lk-tap`.
 */
export const TAP_44_CSS =
  '[data-lk-tap]{position:relative}[data-lk-tap]::before,[data-lk-tap].tap-40::before{content:"";position:absolute;inset-inline:0;top:50%;height:max(100%,44px);transform:translateY(-50%)}';

/**
 * A press target, not text (owner, 2026-11-11): a long press on the mic
 * (push to talk) or the bar must not start an iOS selection or its callout.
 * Only on controls and the bar; the input and the log stay selectable.
 */
export const NO_SELECT = {
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
} as CSSProperties;

/** The input inside a NO_SELECT bar: text again. */
export const TEXT_SELECT = {
  userSelect: "text",
  WebkitUserSelect: "text",
  WebkitTouchCallout: "default",
} as CSSProperties;

/**
 * The mic: CONTROL_W wide to the touch, its circle the line-sized square at
 * its end (the start padding takes the rest). Folded, that end is the bar's corner.
 */
export const MIC_BOX = {
  "--lk-mic-w": CONTROL_W,
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

/**
 * The glass strip's corners (owner, 2026-11-10): with the progress bar in
 * it, the bar is a full pill (its end caps half its height) and the strip's
 * top corners are concentric with those caps — the cap's radius plus the
 * inset between them, the same centre. `slotH` is the bar's slot (the inset
 * above it included), as measured; the bottom corners stay the bar's own.
 */
export const STRIP_INSET_PX = 4;
export function stripTopRadius(slotH: number, inset = STRIP_INSET_PX): number {
  const barH = Math.max(0, slotH - inset);
  return Math.round((barH / 2 + inset) * 10) / 10;
}
