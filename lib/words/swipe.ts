/**
 * Swipe grading on touch (app/(app)/words/WordsClient.tsx, WordRow).
 */
export type SwipeRating = 1 | 2 | 3 | 4;

/**
 * Touch grading by swipe distance: a short swipe is the milder grade, a long
 * one the stronger. ← short Hard, ← long Again; → short Good, → long Easy.
 */
export const SWIPE_PX = 40;
export const SWIPE_FAR_PX = 110;
export const swipeRating = (dx: number): SwipeRating | null =>
  dx <= -SWIPE_FAR_PX
    ? 1
    : dx <= -SWIPE_PX
      ? 2
      : dx >= SWIPE_FAR_PX
        ? 4
        : dx >= SWIPE_PX
          ? 3
          : null;
/**
 * Swipes follow physics: the grade comes from where the row would come to
 * rest if let go, not just where the finger lifted — a quick flick travels
 * further. Exponential deceleration, as iOS scroll views do: at rate `d` per
 * ms, a release at v px/ms coasts v·d/(1−d) px more. 0.99 is iOS's "fast"
 * rate (~99 px per 1 px/ms); a slow, deliberate drag (~0.2 px/ms) barely
 * moves, a flick (1–3 px/ms) reaches the far grade.
 */
export const SWIPE_DECAY = 0.99;
/** Velocity is measured over the last stretch of the gesture only. */
export const SWIPE_VELOCITY_MS = 100;
export const projectSwipe = (dx: number, v: number) =>
  Math.max(-400, Math.min(400, dx + (v * SWIPE_DECAY) / (1 - SWIPE_DECAY)));
/** px/ms over the recent samples; 0 if the finger stopped before lifting. */
export function releaseVelocity(samples: { t: number; x: number }[], now: number) {
  const recent = samples.filter((s) => now - s.t <= SWIPE_VELOCITY_MS);
  if (recent.length < 2 || now - recent.at(-1)!.t > 50) return 0;
  const a = recent[0];
  const b = recent.at(-1)!;
  return b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
}

/**
 * Swipe vs scroll: a gesture commits to one axis once it has moved
 * LOCK_SLOP px, and keeps it until the finger lifts. Sideways means clearly
 * sideways (|x| > 1.5·|y|, under ~34° from horizontal); anything steeper is a
 * scroll and can never grade, however it drifts later.
 */
export const LOCK_SLOP = 10;
export type Axis = "h" | "v";
export function lockAxis(x: number, y: number): Axis | null {
  if (Math.hypot(x, y) < LOCK_SLOP) return null;
  return Math.abs(x) > 1.5 * Math.abs(y) ? "h" : "v";
}

/** Below this, a release is not a flick: speed alone must not grade a twitch. */
export const MIN_FLICK_PX = 16;

/** The grade a sideways gesture gives when released: distance + coasting. */
export function releaseRating(moved: number, v: number): SwipeRating | null {
  if (Math.abs(moved) < MIN_FLICK_PX) return null;
  return swipeRating(projectSwipe(moved, v));
}
