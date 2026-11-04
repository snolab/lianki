/**
 * A mouse wheel or trackpad scroll over the chat's bar (the input, its
 * buttons) scrolls the log above it: the log is click-through, so the bar is
 * where a desktop pointer rests. Whatever under the pointer can still scroll
 * that way itself (a long draft in the textarea, the attach menu) keeps the
 * wheel; so does a pinch (ctrl+wheel) and a sideways swipe. Pure: the DOM
 * walk is given its boxes.
 */

/** One scrollable box: its vertical scroll state. */
export type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Lines and pages (deltaMode 1 and 2) in px, as browsers scroll them. */
export const WHEEL_LINE_PX = 16;

/** The wheel's vertical travel in px. */
export function wheelPx(deltaY: number, deltaMode: number, pageH: number): number {
  return deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaMode === 2 ? deltaY * pageH : deltaY;
}

/** Whether the box can still scroll by dy (down when dy > 0); 1px of rounding slack. */
export function canScroll(b: ScrollBox, dy: number): boolean {
  if (b.scrollHeight - b.clientHeight <= 1) return false;
  return dy > 0 ? b.scrollTop + b.clientHeight < b.scrollHeight - 1 : b.scrollTop > 1;
}

/**
 * The px to scroll the log by for this wheel, or 0 to leave it to the browser.
 * `own`: the scrollable boxes between the pointer's target and the bar (the
 * textarea, a menu), any of which keeps a wheel it can use.
 */
export function forwardWheel(d: {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  own: ScrollBox[];
  log: ScrollBox | null;
}): number {
  if (d.ctrlKey || !d.log || d.deltaY === 0) return 0;
  if (Math.abs(d.deltaX) > Math.abs(d.deltaY)) return 0;
  const dy = wheelPx(d.deltaY, d.deltaMode, d.log.clientHeight);
  if (d.own.some((b) => canScroll(b, dy))) return 0;
  return canScroll(d.log, dy) ? dy : 0;
}
