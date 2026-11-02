/**
 * The binding cords of the /words list (SlipCords in WordsClient). Each row
 * has its own cord segment, pinned at the row's top and bottom where it ties
 * into the neighbours. The focused (loose) row's segment bows inward; it never
 * follows a slide: the cords are the list's, not the slip's.
 */

/** Inward bow of a fully loose cord, as a share of the row height. */
export const CORD_BOW = 0.17;

/**
 * The SVG path of one cord segment at `x`, `h` tall: straight when `bow` is 0,
 * otherwise a smooth S through the middle point `x + bow`. Every x in it is
 * `x + k * bow`, so squeezing the full-bow path by scaleX(s) about `x` draws
 * the path for `s * bow`: the loosening is a CSS transform.
 */
export function cordPath(x: number, h: number, bow: number): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  const mx = x + bow;
  const c = x + (mx - x) * 0.2;
  return (
    `M ${r(x)} 0 C ${r(c)} ${r(h * 0.25)}, ${r(mx)} ${r(h * 0.35)}, ${r(mx)} ${r(h * 0.5)} ` +
    `S ${r(c)} ${r(h * 0.75)}, ${r(x)} ${r(h)}`
  );
}
