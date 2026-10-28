/**
 * Motion that feels physical: positions follow from acceleration, not a
 * fixed speed.
 *
 * - Point-to-point moves (a glance sliding to the end of a long word, a
 *   swiped row returning) follow the minimum-jerk trajectory
 *   10t³ − 15t⁴ + 6t⁵ (Flash & Hogan 1985, the classic model of human
 *   reaching): velocity and acceleration are zero at both ends, so a move
 *   starts and stops without a kick. Its duration follows from a peak
 *   acceleration: T = √(5.77·d / a), longer moves take longer, but only as
 *   the square root of the distance.
 * - The curve is handed to CSS as a `linear()` easing — sampled once, run by
 *   the compositor, so it costs nothing per frame.
 * - Retargetable values (the term column width) use a critically damped
 *   spring, which keeps its velocity when the goal moves.
 */

/** Minimum-jerk position at normalized time t ∈ [0, 1]. */
export const minJerk = (t: number) => t * t * t * (10 + t * (-15 + 6 * t));

/** A CSS `linear()` easing sampling `fn` at n + 1 points. */
export function cssLinear(fn: (t: number) => number, n = 24) {
  const pts = Array.from({ length: n + 1 }, (_, i) => +fn(i / n).toFixed(4));
  return `linear(${pts.join(", ")})`;
}

export const MIN_JERK_EASING = cssLinear(minJerk);

/** Peak-acceleration bound of a minimum-jerk move: a = 5.77·d / T². */
const MIN_JERK_PEAK = 10 / Math.sqrt(3);

/** Seconds a minimum-jerk move of `d` px takes at peak acceleration `a` px/s². */
export const moveSeconds = (d: number, a: number) => Math.sqrt((MIN_JERK_PEAK * Math.abs(d)) / a);

/**
 * One step of a critically damped spring toward `goal` (ω rad/s), from
 * position x with velocity v (per second), over dt seconds. Exact solution,
 * so any frame rate gives the same path.
 */
export function springStep(x: number, v: number, goal: number, dt: number, omega: number) {
  const x0 = x - goal;
  const e = Math.exp(-omega * dt);
  const nx = (x0 + (v + omega * x0) * dt) * e;
  const nv = (v - omega * (v + omega * x0) * dt) * e;
  return { x: goal + nx, v: nv };
}
