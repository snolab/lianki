/**
 * Lifting the chat bar above the on-screen keyboard.
 *
 * The bar is `position: fixed` to the layout viewport's bottom. On iOS the
 * keyboard does not shrink the layout viewport, only the visual one
 * (`window.visualViewport`: `offsetTop` + `height`, in layout px), so a bar
 * dragged low, or a page iOS did not scroll, can end up under the keyboard.
 * The lift is how far the bar must move up to sit `gap` px above the
 * visible area's bottom edge; 0 when it is already visible, so whatever iOS's
 * own scroll-into-view did is left alone.
 *
 * All rects are the bar's resting rect (without any lift), in layout px.
 */
export const KEYBOARD_GAP_PX = 8;
/** Pinched in further than this, the visual viewport is the user's zoom, not a keyboard. */
const ZOOMED = 1.05;

export function keyboardLift(d: {
  /** The bar's resting top and bottom (getBoundingClientRect less the current lift). */
  barTop: number;
  barBottom: number;
  /** visualViewport.offsetTop / height / scale. */
  vvTop: number;
  vvHeight: number;
  vvScale?: number;
  /** env(safe-area-inset-top): never lifted under the notch. */
  safeTop?: number;
  gap?: number;
}): number {
  const gap = d.gap ?? KEYBOARD_GAP_PX;
  if ((d.vvScale ?? 1) > ZOOMED) return 0;
  const visibleBottom = d.vvTop + d.vvHeight;
  const want = d.barBottom + gap - visibleBottom;
  if (want <= 0) return 0;
  // No higher than the visible area's top (and the notch): a short visible
  // area keeps the bar's top edge in view rather than its bottom.
  const minTop = Math.max(d.vvTop + gap, d.safeTop ?? 0);
  const room = Math.max(0, d.barTop - minTop);
  return Math.round(Math.min(want, room));
}
