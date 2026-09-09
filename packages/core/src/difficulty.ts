// Per-video difficulty, derived from the speed markers the userscript already
// records. Framework-neutral: no DOM, no DB.
//
// The premise: the rate you chose to watch a passage at IS a comprehension
// signal. Slowing down means you needed the extra time; speeding up means you
// were ahead of it. That is data no subtitle tool collects, because none of them
// own the playback rate.

/** A stretch of the timeline played at a constant rate. */
export type RateSegment = { from: number; to: number; rate: number };

/** Rates outside this band are clamped — they say "very hard/easy", not more. */
export const RATE_FLOOR = 0.5;
export const RATE_CEIL = 2;

/**
 * Turn the sparse `{timestamp: rate}` markers into a step function over the
 * timeline.
 *
 * A marker means "on reaching this point, set the rate to X", and it holds until
 * the next marker — which is exactly how setupVideoSpeedTracking applies them
 * during playback. Anything before the first marker played at 1.0.
 */
export function rateSegments(
  markers: Record<string | number, number> | undefined,
  duration: number,
): RateSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const points = Object.entries(markers ?? {})
    .map(([t, rate]) => ({ t: Number(t), rate: Number(rate) }))
    .filter((p) => Number.isFinite(p.t) && p.t >= 0 && Number.isFinite(p.rate) && p.rate > 0)
    .sort((a, b) => a.t - b.t);

  const segments: RateSegment[] = [];
  let cursor = 0;
  let rate = 1;
  for (const p of points) {
    if (p.t >= duration) break;
    if (p.t > cursor) segments.push({ from: cursor, to: p.t, rate });
    cursor = p.t;
    rate = p.rate;
  }
  if (cursor < duration) segments.push({ from: cursor, to: duration, rate });
  return segments.filter((s) => s.to > s.from);
}

/**
 * One number for the whole video: the time-weighted **geometric** mean rate.
 * Above 1 you outran it, below 1 you needed it slowed down.
 *
 * Geometric, not arithmetic, because rates are multiplicative — half speed and
 * double speed have to cancel to 1.0, and an arithmetic mean would score that
 * pair 1.25 and call a struggle "comfortable".
 */
export function maturityScore(segments: RateSegment[]): number {
  let total = 0;
  let sumLog = 0;
  for (const s of segments) {
    const span = s.to - s.from;
    if (span <= 0) continue;
    total += span;
    sumLog += Math.log(clampRate(s.rate)) * span;
  }
  return total > 0 ? Math.exp(sumLog / total) : 1;
}

export const clampRate = (rate: number) =>
  Math.min(RATE_CEIL, Math.max(RATE_FLOOR, Number.isFinite(rate) && rate > 0 ? rate : 1));

/**
 * Downsample the step function to `count` equal buckets for rendering, each the
 * geometric mean of whatever overlaps it. Overlap-weighted rather than sampled
 * at the bucket midpoint, so a brief slow passage can't vanish between samples —
 * the short difficult moments are the ones worth seeing.
 */
export function heatmapBuckets(
  segments: RateSegment[],
  duration: number,
  count: number,
): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || count <= 0) return [];
  const width = duration / count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const lo = i * width;
    const hi = lo + width;
    let span = 0;
    let sumLog = 0;
    for (const s of segments) {
      const overlap = Math.min(hi, s.to) - Math.max(lo, s.from);
      if (overlap <= 0) continue;
      span += overlap;
      sumLog += Math.log(clampRate(s.rate)) * overlap;
    }
    out.push(span > 0 ? Math.exp(sumLog / span) : 1);
  }
  return out;
}

/**
 * Colour for a rate. Neutral is a desaturated grey rather than a mid-spectrum
 * yellow: most of a timeline is unmarked and sits at exactly 1.0, and a bar
 * screaming amber across its whole width would read as a warning about nothing.
 * Saturation scales with distance from 1.0, so intensity means confidence.
 */
export function rateColor(rate: number, alpha = 1): string {
  const x = Math.log2(clampRate(rate)); // -1 at 0.5x, +1 at 2x
  // oklch, not hsl: it is perceptually uniform, so equal steps away from 1.0
  // look like equal steps. In hsl the green and red ends at the same lightness
  // read as wildly different brightness, which made "fast" look emphatic and
  // "slow" look washed out even though they are symmetric measurements.
  if (Math.abs(x) < 0.05) return `oklch(0.72 0.012 250 / ${alpha})`;
  const mag = Math.min(1, Math.abs(x));
  const hue = x > 0 ? 148 : 27;
  const chroma = (0.06 + mag * 0.11).toFixed(3);
  const light = (0.68 - mag * 0.08).toFixed(3);
  return `oklch(${light} ${chroma} ${hue} / ${alpha})`;
}

/** Short human label for a score. */
export function maturityLabel(score: number): string {
  if (score >= 1.25) return "comfortable";
  if (score >= 1.05) return "easy";
  if (score > 0.95) return "steady";
  if (score > 0.8) return "effortful";
  return "hard";
}

export type VideoDifficulty = {
  score: number;
  label: string;
  /** Fraction of the timeline actually marked — how much to trust `score`. */
  marked: number;
  segments: RateSegment[];
};

export function videoDifficulty(
  markers: Record<string | number, number> | undefined,
  duration: number,
): VideoDifficulty {
  const segments = rateSegments(markers, duration);
  // Segments still at the default 1.0 carry no signal; only deliberate changes
  // count toward how much of the video has actually been judged.
  const markedSpan = segments
    .filter((s) => Math.abs(s.rate - 1) > 0.01)
    .reduce((sum, s) => sum + (s.to - s.from), 0);
  const score = maturityScore(segments);
  return {
    score,
    label: maturityLabel(score),
    marked: duration > 0 ? Math.min(1, markedSpan / duration) : 0,
    segments,
  };
}
