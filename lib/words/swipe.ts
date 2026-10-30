/**
 * Swipe grading on touch (app/(app)/words/WordsClient.tsx, WordRow).
 */
export type SwipeRating = 1 | 2 | 3 | 4;

/**
 * Touch grading by detents (snap levels), in units of the row's height `a`:
 * level 0 (no grade), ±1 (← Hard / → Good), ±2 (← Again / → Easy). One
 * level is SWIPE_LEVEL·a of finger travel.
 *
 * While dragging, the row follows a smooth staircase of the finger:
 *
 *   t = f / L,   x = a · (t − c·sin(2πt) / 2π)
 *
 * whose slope dx/df = 1 − c·cos(2πt) is 1 − c (0.1) on a level — it holds,
 * yet gives a little — and 1 + c (1.9) between levels, where the row slides
 * into the next one. Past level 2 it stretches at SWIPE_STRETCH, to a hard
 * stop. The level itself has hysteresis: it changes only once t is
 * SWIPE_HYSTERESIS past the midpoint, so a finger resting on a boundary
 * never flickers between grades (0 → 1 at 0.6L ≈ 26 px, 1 → 2 at 1.6L ≈ 70 px).
 * Under SWIPE_START px is no grade at all, so a touch that barely moves never grades.
 */
export const SWIPE_START = 16;
/** The row height on touch. */
export const SWIPE_ROW_PX = 44;
/** Finger travel per level, in rows. */
export const SWIPE_LEVEL = 1;
/**
 * How strongly the detents pull, relative to the first tuning (c = 0.75,
 * spring ω = 25): the A/B knob. It scales the hold on a level (SWIPE_SNAP)
 * and the release spring (SWIPE_SPRING). It does not touch the level
 * thresholds or the flick's coast, so a fling skips no more easily.
 */
export const SNAP_STRENGTH = 1.2;
/**
 * How strongly a level holds: the row follows 1 − c of the finger on a level.
 * Capped below 1, where the row would stop following the finger at all.
 */
export const SWIPE_SNAP = Math.min(0.95, Math.round(75 * SNAP_STRENGTH) / 100);
export const SWIPE_HYSTERESIS = 0.1;
/** Past the last level the row follows this much of the finger… */
export const SWIPE_STRETCH = 0.3;
/** …up to this many rows out. */
export const SWIPE_STOP = 2.5;
export const SWIPE_MAX_LEVEL = 2;

export type SwipeLevel = -2 | -1 | 0 | 1 | 2;

/** The row's position for a finger travel `finger`: the snapping staircase. */
export function snapSwipe(finger: number, a = SWIPE_ROW_PX) {
  const L = SWIPE_LEVEL * a;
  const f = Math.abs(finger);
  const top = SWIPE_MAX_LEVEL * L;
  const x =
    f <= top
      ? a * (f / L - (SWIPE_SNAP * Math.sin((2 * Math.PI * f) / L)) / (2 * Math.PI))
      : Math.min(SWIPE_STOP * a, SWIPE_MAX_LEVEL * a + (f - top) * SWIPE_STRETCH);
  return Math.sign(finger) * x;
}

/** The level after finger travel `finger`, from level `from`: hysteresis both ways. */
export function swipeLevel(finger: number, from: number = 0, a = SWIPE_ROW_PX): SwipeLevel {
  const t = finger / (SWIPE_LEVEL * a);
  let k = from;
  while (k < SWIPE_MAX_LEVEL && t > k + 0.5 + SWIPE_HYSTERESIS) k++;
  while (k > -SWIPE_MAX_LEVEL && t < k - 0.5 - SWIPE_HYSTERESIS) k--;
  return k as SwipeLevel;
}

/** The grade a level gives: ← Again (−2) / Hard (−1), → Good (1) / Easy (2). */
export const levelRating = (k: number): SwipeRating | null =>
  k === 0 ? null : k < 0 ? (k <= -2 ? 1 : 2) : k >= 2 ? 4 : 3;

/**
 * A flick carries on: the finger's speed adds v·SWIPE_COAST_MS of travel at
 * release — but it moves the level at most one step past where it was held,
 * so no flick lands on Again/Easy from rest.
 */
export const SWIPE_COAST_MS = 30;
/** Velocity is measured over the last stretch of the gesture only. */
export const SWIPE_VELOCITY_MS = 100;
export function releaseLevel(finger: number, v: number, held: number, a = SWIPE_ROW_PX) {
  const k = swipeLevel(finger + v * SWIPE_COAST_MS, held, a);
  return Math.max(held - 1, Math.min(held + 1, k)) as SwipeLevel;
}

/**
 * The release: back home on a critically damped spring (as the column widths
 * move), ω = SWIPE_SPRING rad/s, sampled into a CSS easing over the time it
 * takes to settle — the compositor runs it, no script per frame.
 */
export const SWIPE_SPRING = 25 * SNAP_STRENGTH;
const SETTLE = 7.4; // ωt at which (1 + ωt)e^−ωt < 0.5%
export const SWIPE_RETURN_S = SETTLE / SWIPE_SPRING;
export const springProgress = (t: number) =>
  t >= 1 ? 1 : 1 - (1 + SETTLE * t) * Math.exp(-SETTLE * t);
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

/** The grade a sideways gesture gives when released from level `held`. */
export function releaseRating(
  finger: number,
  v: number,
  held: number = swipeLevel(finger),
  a = SWIPE_ROW_PX,
): SwipeRating | null {
  // Speed alone must not grade a twitch.
  if (Math.abs(finger) < SWIPE_START) return null;
  return levelRating(releaseLevel(finger, v, held, a));
}

/**
 * Variant B (NativeSlipRow): the grade of where a native scroller came to
 * rest, `offset` px from centre (+ = slid right). Same tiers as above: under
 * SWIPE_START nothing, within a ← Hard / → Good, beyond it ← Again / → Easy.
 */
export function restRating(offset: number, a = SWIPE_ROW_PX): SwipeRating | null {
  const d = Math.abs(offset);
  if (d < SWIPE_START) return null;
  const strong = d > a + 0.5;
  return offset > 0 ? (strong ? 4 : 3) : strong ? 1 : 2;
}

/**
 * What the reveal under a sliding slip shows on each side at level `k`. A far
 * detent's grade replaces the first detent's in the same spot (no stacking):
 * slid right, Good until Easy; slid left, Hard until Again. Back on the first
 * detent, its own grade returns.
 */
export function revealShown(k: number): { good: 3 | 4; hard: 2 | 1 } {
  return { good: k >= 2 ? 4 : 3, hard: k <= -2 ? 1 : 2 };
}
