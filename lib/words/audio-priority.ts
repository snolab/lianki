/**
 * Which rows' audio to fetch first on /words (the owner, 2026-10-30): the
 * rows on screen, then their neighbours outward — one below, one above, two
 * below, … — across the rendered window, then a few more past its end in
 * queue order. Today's due words come after all of these (AudioCache.stock).
 */
export function rowPriority(
  len: number,
  /** First and one-past-last row on screen. */
  first: number,
  last: number,
  /** The rendered window (with its overscan). */
  from: number,
  to: number,
  /** Rows past the window's end, in queue order. */
  beyond: number,
): { visible: number[]; rest: number[] } {
  const clamp = (n: number) => Math.max(0, Math.min(len, n));
  first = clamp(first);
  last = Math.max(first, clamp(last));
  from = Math.min(clamp(from), first);
  to = Math.max(clamp(to), last);
  const visible: number[] = [];
  for (let i = first; i < last; i++) visible.push(i);
  const rest: number[] = [];
  for (let d = 0; last + d < to || first - 1 - d >= from; d++) {
    if (last + d < to) rest.push(last + d);
    if (first - 1 - d >= from) rest.push(first - 1 - d);
  }
  for (let i = to; i < Math.min(len, to + beyond); i++) rest.push(i);
  return { visible, rest };
}
