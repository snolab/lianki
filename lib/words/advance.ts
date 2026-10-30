/**
 * Auto-advance on /words: grading row `i` moves on to the next row (the
 * touch focus, the list scrolling up one row, the desktop cursor) only when
 * `i` had no grade yet in this session. Re-grading a card already answered
 * keeps it in place (the owner, 2026-10-30).
 */
export function shouldAdvance(grades: ReadonlyMap<number, unknown>, i: number): boolean {
  return !grades.has(i);
}
