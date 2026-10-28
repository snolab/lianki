/**
 * Swipe grading on touch (app/(app)/words/WordsClient.tsx, WordRow).
 */
export type SwipeRating = 1 | 2 | 3 | 4;

/**
 * Touch grading by where a row is let go, in units of the row's height `a`:
 * the row travels at most 2a either way (a hard stop). Landing within a is
 * the milder grade, between a and 2a the stronger one:
 * ← Hard / ← Again, → Good / → Easy. Under SWIPE_START px is no grade at
 * all, so a touch that barely moves never grades.
 */
export const SWIPE_START = 16;
/** The row height on touch: 2a of travel each way. */
export const SWIPE_ROW_PX = 44;
/** 0 = no grade, 1 = the milder grade, 2 = the stronger. */
export function swipeTier(dx: number, a = SWIPE_ROW_PX): 0 | 1 | 2 {
  const d = Math.abs(dx);
  return d < SWIPE_START ? 0 : d <= a ? 1 : 2;
}
export const swipeRating = (dx: number, a = SWIPE_ROW_PX): SwipeRating | null => {
  const t = swipeTier(dx, a);
  if (!t) return null;
  return dx < 0 ? (t === 2 ? 1 : 2) : t === 2 ? 4 : 3;
};
/** The finger's travel, held at the 2a stop. */
export const clampSwipe = (dx: number, a = SWIPE_ROW_PX) => Math.max(-2 * a, Math.min(2 * a, dx));
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
/** Where a release would come to rest — never past the 2a stop. */
export const projectSwipe = (dx: number, v: number, a = SWIPE_ROW_PX) =>
  clampSwipe(dx + (v * SWIPE_DECAY) / (1 - SWIPE_DECAY), a);
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

/** The grade a sideways gesture gives when released: distance + coasting. */
export function releaseRating(moved: number, v: number, a = SWIPE_ROW_PX): SwipeRating | null {
  // Speed alone must not grade a twitch.
  if (Math.abs(moved) < SWIPE_START) return null;
  return swipeRating(projectSwipe(moved, v, a), a);
}
