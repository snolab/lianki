/**
 * A word list's progress, for the /words list picker (the owner, 2026-10-31:
 * "too coarse, use weighting"). Each word scores
 *
 *     score = min(1, ln(1 + s) / ln(1 + scale))
 *
 * where s is its FSRS stability in days (its current interval when the card
 * has no stability), and scale is a year (PROGRESS_SCALE_DAYS) or the list's
 * shorter interval cap. A word never studied scores 0. The list's progress
 * is the mean score over all its words, so 100% means every word is at about
 * a year or more, and partial progress counts. A group or a parent list sums
 * its whole subtree first (the Anki subdeck rule), then divides.
 *
 * The server sends each list's score sum (`progress`, lib/repos/wordsD1.ts);
 * the picker adds them up the tree and divides by the words in it.
 *
 * Hook, not built (the owner has not decided): a per-word `weight` (e.g. by
 * word frequency). With weights, the sum is Σ weight·score and the
 * denominator Σ weight over every word in the list, unstudied ones included.
 * Unweighted, each weight is 1 and the denominator is the word count.
 */

/** A year: a word this stable or more counts in full. */
export const PROGRESS_SCALE_DAYS = 365;

/** What decides one word's score. */
export type ProgressWord = {
  /** FSRS stability, days. */
  stability?: number | null;
  /** The current interval (ts-fsrs `scheduled_days`), used without a stability. */
  interval?: number | null;
  /** Reserved: a per-word weight (frequency…). Not used yet; 1. */
  weight?: number;
};

/** One word's score, 0..1. */
export function wordScore(w: ProgressWord, scale = PROGRESS_SCALE_DAYS): number {
  const s = w.stability != null && w.stability > 0 ? w.stability : (w.interval ?? 0);
  if (!(s > 0) || !(scale > 0)) return 0;
  return Math.min(1, Math.log1p(s) / Math.log1p(scale));
}

/** The scores of the words studied, summed (the unstudied add 0). */
export function scoreSum(words: Iterable<ProgressWord>, scale = PROGRESS_SCALE_DAYS): number {
  let sum = 0;
  for (const w of words) sum += wordScore(w, scale);
  return sum;
}

/**
 * The list's progress as a whole percentage, rounded down (100 only when
 * every word is in full), from its score sum and its word count. Null when
 * the count is not known.
 */
export function progressPercent(sum: number, total: number): number | null {
  if (!(total > 0)) return null;
  const share = Math.max(0, Math.min(1, sum / total));
  // A hair under a whole number is float noise, not progress lost.
  return Math.floor(share * 100 + 1e-9);
}
