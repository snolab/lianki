/**
 * Auto-advance on /words: grading row `i` moves on to the next row (the
 * touch focus, the list scrolling up one row, the desktop cursor) only when
 * `i` had no grade yet in this session. Re-grading a card already answered
 * keeps it in place (the owner, 2026-10-30).
 */
export function shouldAdvance(grades: ReadonlyMap<number, unknown>, i: number): boolean {
  return !grades.has(i);
}

/**
 * Where the list scrolls to after grading `row` for the first time: one row
 * further than it is now, as an absolute scrollTop. While an earlier advance
 * is still on its way (`pending`), the step is taken from that target, not
 * from wherever the list is mid-way. A second advance for the same row is
 * dropped (null), so one grade moves the list by exactly one row.
 */
export function advanceTop(o: {
  row: number;
  scrollTop: number;
  rowH: number;
  max: number;
  pending: { row: number; top: number } | null;
}): number | null {
  if (o.pending?.row === o.row) return null;
  const from = o.pending ? o.pending.top : o.scrollTop;
  return Math.max(0, Math.min(Math.max(0, o.max), Math.round(from + o.rowH)));
}
