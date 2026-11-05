/**
 * Scroll `box` (never the page) so `el`, inside it, is in its middle — when
 * `el` is not fully in view already. For the card word of a long example
 * (lib/words/example-target.ts) in a scrolling card: scrollIntoView would move
 * the page too.
 */
export function centreIn(box: HTMLElement, el: HTMLElement, smooth: boolean): void {
  const b = box.getBoundingClientRect();
  const r = el.getClientRects()[0] ?? el.getBoundingClientRect();
  const dy =
    r.top < b.top || r.bottom > b.bottom ? r.top + r.height / 2 - (b.top + b.height / 2) : 0;
  const dx =
    r.left < b.left || r.right > b.right ? r.left + r.width / 2 - (b.left + b.width / 2) : 0;
  if (!dx && !dy) return;
  box.scrollBy({ top: dy, left: dx, behavior: smooth ? "smooth" : "auto" });
}

type Rect = { top: number; bottom: number; left: number; right: number };
/** What these helpers read of an element: the DOM's own fields, so tests can pass plain objects. */
export type Rects = {
  getBoundingClientRect(): Rect;
  getClientRects(): ArrayLike<Rect & { width: number; height: number }>;
};
export type AimBox = Rects & {
  clientWidth: number;
  scrollWidth: number;
  scrollTo(o: ScrollToOptions): void;
};
export type AimInner = Rects & { scrollHeight: number };

/**
 * How far an example cell `o` (clipping, scrolled by its own scrollTop /
 * scrollLeft) scrolls so the word `t` is in the middle, or 0 when the word is
 * in view unscrolled (#528). Wrapped (`lines` lines of `lh` px): whole lines,
 * the word's first line in the middle line (the first of two, so the sentence
 * reads on). One line: the word's centre at the cell's centre, measured from
 * the line's start side (`rtl`: the right). Scroll-independent: `i` is the
 * content inside `o`, moving with it.
 */
export function aimAt(
  o: AimBox,
  i: AimInner,
  t: Rects,
  wrap: boolean,
  lines: number,
  lh: number,
  rtl: boolean,
): number {
  const r = t.getClientRects()[0];
  if (!r) return 0;
  const ir = i.getBoundingClientRect();
  if (wrap) {
    if (!lh) return 0;
    const line = Math.floor((r.top - ir.top + r.height / 2) / lh);
    if (line < lines) return 0;
    const last = Math.max(0, Math.round(i.scrollHeight / lh) - lines);
    return Math.max(0, Math.min(line - Math.floor((lines - 1) / 2), last)) * lh;
  }
  const start = rtl ? ir.right - r.right : r.left - ir.left;
  if (start + r.width <= o.clientWidth) return 0;
  const room = o.scrollWidth - o.clientWidth;
  return Math.max(0, Math.min(start + r.width / 2 - o.clientWidth / 2, room));
}

/** Scroll the cell to `aim` (from `aimAt`): down when wrapped, along the line otherwise. */
export function scrollToAim(
  o: Pick<AimBox, "scrollTo">,
  aim: number,
  wrap: boolean,
  rtl: boolean,
  smooth: boolean,
) {
  o.scrollTo({
    ...(wrap ? { top: aim } : { left: rtl ? -aim : aim }),
    behavior: smooth ? "smooth" : "auto",
  });
}

/** Whether `t` is wholly inside the visible part of `o` now (a pixel of slack), along the scroll axis. */
export function inViewIn(o: Rects, t: Rects, wrap: boolean): boolean {
  const r = t.getClientRects()[0];
  if (!r) return true;
  const b = o.getBoundingClientRect();
  return wrap
    ? r.top >= b.top - 1 && r.bottom <= b.bottom + 1
    : r.left >= b.left - 1 && r.right <= b.right + 1;
}
