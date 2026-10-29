/**
 * The term column's width in the word list (app/(app)/words/WordsClient.tsx):
 * as wide as the terms around the middle of the screen need, so a stretch of
 * short words leaves more room for meanings and examples — without columns
 * jumping as rows scroll by.
 *
 * Learned from snomiao/rgui's track widths (src/lane/timeline.ts): demand
 * weighted by distance, a clamp, a dead band, and a glide instead of a snap.
 *  - Rows are weighted by a Gaussian of their distance from the screen's
 *    centre, so rows entering at the edges barely count.
 *  - The 85th percentile, not the max: one very long term truncates rather
 *    than widening the whole list.
 *  - The goal moves only when the target leaves a dead band, in quantized
 *    steps; the shown width follows it on a spring (lib/words/motion.ts).
 */
export const TERM_MIN_REM = 6;
export const TERM_MAX_REM = 20;
export const TOUCH_TERM_MIN_REM = 5;
export const TOUCH_TERM_MAX_REM = 12;
export const COLUMN_QUANTILE = 0.85;
const QUANTILE = COLUMN_QUANTILE;
const BAND_REM = 1.5;
const STEP_REM = 0.5;

/** The q-quantile of values weighted by w (weights need not sum to 1). */
export function weightedQuantile(samples: [value: number, weight: number][], q: number): number {
  const s = samples.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
  if (!s.length) return 0;
  const total = s.reduce((t, [, w]) => t + w, 0);
  let acc = 0;
  for (const [v, w] of s) {
    acc += w;
    if (acc >= q * total) return v;
  }
  return s.at(-1)![0];
}

/** Weight of a row whose centre is `d` px from the screen's centre. */
export const centreWeight = (d: number, viewH: number) => Math.exp(-((d / viewH) ** 2) * 4);

/** The width (px) the term column should have for these rows. */
export function termTarget(
  rows: { width: number; distance: number }[],
  viewH: number,
  rem: number,
  touch = false,
) {
  const [lo, hi] = touch ? [TOUCH_TERM_MIN_REM, TOUCH_TERM_MAX_REM] : [TERM_MIN_REM, TERM_MAX_REM];
  const w = weightedQuantile(
    rows.map((r) => [r.width, centreWeight(r.distance, viewH)]),
    QUANTILE,
  );
  // + 1rem: the gap and a little air after the longest term.
  return Math.min(hi * rem, Math.max(lo * rem, w + rem));
}

/** The new goal: unchanged inside the dead band, else the target quantized. */
export function nextGoal(goal: number | null, target: number, rem: number) {
  if (goal !== null && Math.abs(target - goal) <= BAND_REM * rem) return goal;
  return Math.round(target / (STEP_REM * rem)) * STEP_REM * rem;
}

/** Neither the meaning nor the example column narrower than this. */
export const SPLIT_MIN_REM = 8;

/**
 * Desktop with examples: the meaning column's width (px) out of the `avail`
 * px the meaning and example columns share. When both fit, each gets what
 * it needs and the room left over is split evenly; when they do not, the
 * room is shared in proportion to need — so a stretch of long meanings and
 * short examples widens the meanings, and the other way round.
 */
export function splitTarget(backNeed: number, exNeed: number, avail: number, rem: number) {
  const min = SPLIT_MIN_REM * rem;
  if (avail <= 2 * min) return avail / 2;
  const need = backNeed + exNeed;
  const back =
    need <= 0
      ? avail / 2
      : need <= avail
        ? backNeed + (avail - need) / 2
        : (avail * backNeed) / need;
  return Math.min(avail - min, Math.max(min, back));
}
