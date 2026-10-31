/**
 * The chat log's display, shared by the log and the state tree: no box, just
 * text over the page (the box's halo keeps it legible), click-through except
 * for rows that opt in, fading out at its top edge once there is more than
 * fits. Compact (3 lines) at rest; open to 30vh while the input has focus or
 * the mic is on.
 */

/** Older lines dissolve at the top edge (only once there is more than fits). */
export const FADE = "linear-gradient(to bottom, transparent, black 2.5rem)";
/** The compact surface fades over less, so its 3 lines stay legible. */
export const FADE_SHORT = "linear-gradient(to bottom, transparent, black 0.9rem)";

/** Props for a log surface element: its classes and its fade mask. */
export function logSurface({ expanded, fade }: { expanded: boolean; fade: boolean }) {
  const mask = expanded ? FADE : FADE_SHORT;
  return {
    style: fade ? { maskImage: mask, WebkitMaskImage: mask } : undefined,
    className: `min-h-12 space-y-0.5 overflow-y-auto px-0 py-1.5 transition-[max-height] duration-150 ease-out motion-reduce:transition-none ${expanded ? "max-h-[30vh]" : "max-h-[4.4rem]"}`,
  };
}

/** Above the full-screen log's top: the visible top (notch, keyboard pan) plus this. */
export const FULL_LOG_GAP_PX = 8;

/**
 * The full-screen log (while a vertical drag on the bar scrolls it): how tall
 * it may grow, upward from where its bottom edge already is (just above the
 * bar, which stays put), to the visible top less the notch. Never shorter
 * than it is.
 */
export function fullLogHeight(d: {
  /** The log's rect now (layout px). */
  bottom: number;
  height: number;
  /** env(safe-area-inset-top), and visualViewport.offsetTop (a keyboard pan). */
  safeTop: number;
  vvTop?: number;
}): number {
  const top = Math.max(d.safeTop, d.vvTop ?? 0) + FULL_LOG_GAP_PX;
  return Math.round(Math.max(d.height, d.bottom - top));
}

/**
 * The scrollTop that keeps the same distance from the end (`gap`, px below
 * the view) after the log's height changed, so the lines at its bottom edge,
 * which does not move, stay where they were.
 */
export function keepEndGap(d: { scrollHeight: number; clientHeight: number; gap: number }): number {
  return Math.max(0, Math.round(d.scrollHeight - d.clientHeight - Math.max(0, d.gap)));
}

/**
 * A stronger halo for lines floating straight over the page (the minimized
 * chat's floating and frontier lines): text only, never a fill. Layers of
 * text-shadow in the page colour; where --background is missing the whole
 * declaration is dropped, so it can only fall back to no halo, never a box.
 */
export const LINE_HALO = [1, 2, 4, 8]
  .map((px) => `0 0 ${px}px var(--background)`)
  .join(", ");

/**
 * Size-snapping for the full-screen log (no device or orientation checks):
 * each axis snaps to the screen's edges when the screen is smaller than
 * that axis's threshold, else keeps its own size. Like CSS
 * `max(keep, min(screen, (threshold − screen) · ∞))`.
 */
export function snapAxis(screen: number, keep: number, threshold: number): number {
  return Math.max(keep, Math.min(screen, (threshold - screen) * 1e9));
}
/** Below this viewport height it snaps to the full height (every phone and tablet). */
export const LOG_SNAP_H_PX = 1600;

/**
 * The full-screen log's box (viewport px) when a drag on the empty input
 * opened it. Its width never changes (a wider log would reflow its lines
 * under the reader's eye): only the height snaps (snapAxis), to the visible
 * area from top to bottom, less the notch, the home indicator or the
 * keyboard. The bar steps aside for it.
 */
export function fullLogBox(d: {
  vh: number;
  /** The visible area: visualViewport offsetTop and offsetTop + height (else 0 and vh). */
  visibleTop: number;
  visibleBottom: number;
  safe: { top: number; bottom: number };
  /** The log's rect now. */
  log: { left: number; width: number; bottom: number; height: number };
  gap?: number;
}): { left: number; width: number; top: number; bottom: number; hideBar: true } {
  const g = d.gap ?? FULL_LOG_GAP_PX;
  const top = Math.max(d.safe.top, d.visibleTop) + g;
  const bottom = Math.round(Math.min(d.visibleBottom, d.vh - d.safe.bottom) - g);
  const fullH = bottom - top;
  const height = Math.round(snapAxis(fullH, d.log.height, LOG_SNAP_H_PX - (d.vh - fullH)));
  return {
    left: Math.round(d.log.left),
    width: Math.round(d.log.width),
    top: bottom - height,
    bottom,
    hideBar: true,
  };
}

/**
 * The full-screen log's glass (docs/design-principles.md, "Glass"): a scrim
 * in the page's own tone, tuned per scheme, under a strong blur, so the
 * page still shows through (the floor-to-ceiling window) while the log's
 * lines stay legible over a busy page. Without backdrop-filter, or with
 * reduced transparency, the scrim goes near-opaque instead.
 */
export const SHEET_SCRIM = {
  light: { l: 0.98, c: 0.01, h: 90, a: 0.72 },
  dark: { l: 0.18, c: 0.01, h: 260, a: 0.66 },
} as const;
/** The scrim's alpha where nothing blurs behind it. */
export const SHEET_SOLID_ALPHA = 0.92;
export const SHEET_FILTER = "blur(20px) saturate(1.6)";

type Oklch = { l: number; c: number; h: number };
const scrimCss = (k: Oklch, a: number) => `oklch(${k.l * 100}% ${k.c} ${k.h} / ${a})`;
/** The scrim as CSS, both schemes in one value (light-dark follows the page's color-scheme). */
export function sheetScrim(solid: boolean): string {
  const { light, dark } = SHEET_SCRIM;
  const a = (s: { a: number }) => (solid ? SHEET_SOLID_ALPHA : s.a);
  return `light-dark(${scrimCss(light, a(light))}, ${scrimCss(dark, a(dark))})`;
}

/** oklch → gamma-encoded sRGB channels, clamped (how the browser blends). */
export function oklchToSrgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const gamma = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  return lin.map(gamma) as [number, number, number];
}

/** WCAG relative luminance of gamma-encoded sRGB. */
export function srgbLuminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The contrast of `text` on the scrim (alpha `a`) over `behind` (what the
 * page shows there, after any blur), blended in sRGB as browsers do.
 */
export function textOnScrim(text: Oklch, scrim: Oklch, a: number, behind: [number, number, number]) {
  const s = oklchToSrgb(scrim);
  const mix = s.map((v, i) => a * v + (1 - a) * behind[i]!) as [number, number, number];
  const y1 = srgbLuminance(oklchToSrgb(text));
  const y2 = srgbLuminance(mix);
  return (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05);
}

/**
 * The full-screen log's overscroll slack: empty travel above the first line
 * and below the last, this share of its height, so any line can be brought
 * to the middle (as the /words list's OVERSCROLL_FRACTION does).
 */
export const FULL_LOG_OVERSCROLL = 0.45;
export const fullLogPad = (height: number) => Math.round(height * FULL_LOG_OVERSCROLL);

/** The line the reader is on: the one under the focus line (the view's centre), else the nearest. */
export function pickAnchor<T extends { top: number; bottom: number }>(
  rows: readonly T[],
  focusY: number,
): T | null {
  let best: T | null = null;
  let gap = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const d = focusY < r.top ? r.top - focusY : focusY > r.bottom ? focusY - r.bottom : 0;
    if (d < gap) {
      best = r;
      gap = d;
    }
  }
  return best;
}

/**
 * The scrollTop that keeps the anchored line where it was across a height
 * change (entering or leaving full screen, the keyboard): back at its old
 * top, or, if the view no longer reaches there, as close as the view allows
 * (its top edge inside [view.top, view.bottom - height]). Clamped to the
 * scroll range.
 */
export function anchorScrollTop(d: {
  /** The line's top before the change, and now (viewport px), and its height. */
  before: number;
  after: number;
  height: number;
  /** The scroller's visible box now. */
  view: { top: number; bottom: number };
  scrollTop: number;
  maxScroll: number;
}): number {
  const lo = d.view.top;
  const hi = Math.max(lo, d.view.bottom - d.height);
  const target = Math.min(hi, Math.max(lo, d.before));
  const want = d.scrollTop + (d.after - target);
  return Math.max(0, Math.min(Math.max(0, d.maxScroll), Math.round(want)));
}
