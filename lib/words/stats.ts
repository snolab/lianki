/**
 * The /words picker's stats (app/(app)/words/WordsStats.tsx): pure helpers
 * for the study heatmap and the headline numbers. Days are the reader's local
 * calendar days, as YYYY-MM-DD keys (en-CA), built with local Date arithmetic
 * so a DST change never skips or doubles a day.
 */

/** Weeks the heatmap shows: about six months. */
export const STATS_WEEKS = 26;
/** Days the server reads: the whole grid, whichever weekday today is. */
export const STATS_DAYS = STATS_WEEKS * 7;

/** One row from GET /api/words/stats: day, list id, words graded, new words. */
export type StatsTuple = [day: string, listId: string, words: number, fresh: number];

export type DayStats = { words: number; fresh: number };

export const dayKey = (d: Date): string => d.toLocaleDateString("en-CA");

/** The reader's UTC offset in minutes east (JST 540), for the server. */
export const tzOffset = (d = new Date()): number => -d.getTimezoneOffset();

/** Per-day totals over the lists shown (other pages' lists, e.g. alphabets, left out). */
export function sumByDay(rows: StatsTuple[], listIds?: Set<string>): Map<string, DayStats> {
  const out = new Map<string, DayStats>();
  for (const [day, list, words, fresh] of rows) {
    if (listIds && !listIds.has(list)) continue;
    const d = out.get(day) ?? { words: 0, fresh: 0 };
    d.words += words;
    d.fresh += fresh;
    out.set(day, d);
  }
  return out;
}

/**
 * Days in a row with study, ending today; a day not yet studied today does
 * not break it (counted up to yesterday then).
 */
export function streak(days: Map<string, DayStats>, today = new Date()): number {
  const at = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!(days.get(dayKey(at))?.words ?? 0)) at.setDate(at.getDate() - 1);
  let n = 0;
  while ((days.get(dayKey(at))?.words ?? 0) > 0) {
    n++;
    at.setDate(at.getDate() - 1);
  }
  return n;
}

/**
 * The grid, GitHub-style: columns are weeks (Sunday first), the last column
 * holds today. Days after today are null.
 */
export function gridWeeks(today = new Date(), weeks = STATS_WEEKS): (string | null)[][] {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - start.getDay() - (weeks - 1) * 7);
  const end = dayKey(today);
  const out: (string | null)[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: (string | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const at = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      const k = dayKey(at);
      col.push(k <= end ? k : null);
    }
    out.push(col);
  }
  return out;
}

/**
 * Ink level 0..steps of a day's mark, against the reader's own busy days (the
 * 90th percentile of studied days), so a light learner's grid is not all faint
 * and a heavy one's not all full. 4 steps for the seals, ink and notches; 5
 * for the strokes of 正.
 */
export function inkScale(days: Map<string, DayStats>, steps = 4): (words: number) => number {
  const counts = [...days.values()]
    .map((d) => d.words)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const top = counts.length
    ? counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.9))]
    : 1;
  return (words) => {
    if (words <= 0) return 0;
    return Math.min(steps, Math.max(1, Math.ceil((steps * words) / Math.max(1, top))));
  };
}

/** A small, stable tilt per day (degrees), so the seals look stamped by hand. */
export function sealTilt(day: string): number {
  let h = 0;
  for (let i = 0; i < day.length; i++) h = (h * 31 + day.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 11) - 5) * 1.2;
}
