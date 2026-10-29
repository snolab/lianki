/**
 * Swipe grading on touch (app/(app)/words/WordsClient.tsx, WordRow).
 */
export type SwipeRating = 1 | 2 | 3 | 4;

/**
 * Touch grading by where a row comes to rest, in units of the row's height
 * `a`: the row travels at most 2a either way (a hard stop). Up to a it
 * follows the finger 1:1; beyond a it resists — each finger px moves it
 * SWIPE_RESIST px, like a rubber band — so the far grade takes a deliberate
 * push: about 2.25a of finger (≈100 px on a phone), since the owner found
 * Again/Easy too easy to fall into at 1.4a. Resting within SWIPE_STRONG·a is the milder grade, beyond it the
 * stronger: ← Hard / ← Again, → Good / → Easy. Under SWIPE_START px is no
 * grade at all, so a touch that barely moves never grades.
 */
export const SWIPE_START = 16;
/** The row height on touch: 2a of travel each way. */
export const SWIPE_ROW_PX = 44;
export const SWIPE_RESIST = 0.4;
export const SWIPE_STRONG = 1.5;
/** 0 = no grade, 1 = the milder grade, 2 = the stronger — of a row position. */
export function swipeTier(dx: number, a = SWIPE_ROW_PX): 0 | 1 | 2 {
  const d = Math.abs(dx);
  return d < SWIPE_START ? 0 : d <= SWIPE_STRONG * a ? 1 : 2;
}
export const swipeRating = (dx: number, a = SWIPE_ROW_PX): SwipeRating | null => {
  const t = swipeTier(dx, a);
  if (!t) return null;
  return dx < 0 ? (t === 2 ? 1 : 2) : t === 2 ? 4 : 3;
};
/** The row's position for a finger travel: 1:1 up to a, resisted beyond, stopped at 2a. */
export function clampSwipe(finger: number, a = SWIPE_ROW_PX) {
  const f = Math.abs(finger);
  const r = f <= a ? f : Math.min(2 * a, a + (f - a) * SWIPE_RESIST);
  return Math.sign(finger) * r;
}
/**
 * Swipes follow physics: the grade comes from where the row would come to
 * rest if let go, not just where the finger lifted — a quick flick travels
 * further. Exponential deceleration, as iOS scroll views do: at rate `d` per
 * ms, a release at v px/ms coasts v·d/(1−d) px more (of finger travel, so
 * the coast meets the same resistance). 0.97 coasts ~32 px per 1 px/ms: a
 * casual flick stays on the milder grade, only a hard one (≳2.5 px/ms)
 * reaches the far grade. (0.99, then 0.98, made flicks land there too often.)
 */
export const SWIPE_DECAY = 0.97;
/** Velocity is measured over the last stretch of the gesture only. */
export const SWIPE_VELOCITY_MS = 100;
/** Where the row would come to rest after a release from finger travel `finger`. */
export const projectSwipe = (finger: number, v: number, a = SWIPE_ROW_PX) =>
  clampSwipe(finger + (v * SWIPE_DECAY) / (1 - SWIPE_DECAY), a);
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
export function releaseRating(finger: number, v: number, a = SWIPE_ROW_PX): SwipeRating | null {
  // Speed alone must not grade a twitch.
  if (Math.abs(finger) < SWIPE_START) return null;
  return swipeRating(projectSwipe(finger, v, a), a);
}
