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
