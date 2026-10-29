/**
 * The binding cords of a focused (loose) slip. Each cord segment is pinned
 * at the slip's top and bottom, where it ties into the neighbours; its middle
 * bows inward by its slack and is dragged along when the slip slides, up to
 * how far the slack lets it go.
 */

/** Inward bow of a fully loose cord, as a share of the row height. */
export const CORD_BOW = 0.17;
/** How far a slide can drag the loose cord's middle, as a share of the row height. */
export const CORD_REACH = 0.55;

/** How far the middle of a loose cord follows a slide of `dx`. */
export function cordPull(dx: number, slack: number, h: number): number {
  const reach = CORD_REACH * h;
  return Math.max(-reach, Math.min(reach, dx)) * slack;
}

/**
 * The SVG path of one cord segment at `x`, `h` tall: straight when the middle
 * offset (`bow + shift`) is 0, otherwise a smooth S through the middle point.
 */
export function cordPath(x: number, h: number, bow: number, shift: number): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  const mx = x + bow + shift;
  const c = x + (mx - x) * 0.2;
  return (
    `M ${r(x)} 0 C ${r(c)} ${r(h * 0.25)}, ${r(mx)} ${r(h * 0.35)}, ${r(mx)} ${r(h * 0.5)} ` +
    `S ${r(c)} ${r(h * 0.75)}, ${r(x)} ${r(h)}`
  );
}
