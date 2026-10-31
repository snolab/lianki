/**
 * The swipe's physics, pure (the headless core, docs/swipe-core.md). Nothing
 * here touches the DOM or React: lib/words/swipe-core.tsx drives the rows
 * with it, and unit/swipe-physics.test.ts checks it.
 *
 * - A damped spring with mass, stiffness and damping, solved exactly
 *   (under-, critically and over-damped), so any frame rate gives the same path.
 * - A fling: velocity decaying under friction, v(t) = v₀·e^(−k·t).
 * - A rubber band: iOS's (1 − 1/(x·c/d + 1))·d, which never passes d.
 * - The release: coast out under friction, then spring home — one path,
 *   continuous in position and velocity, sampled into a CSS `linear()` easing.
 */
import { snapDetent } from "@lianki/debug-chat/detent";
import { SWIPE_LEVEL, SWIPE_MAX_LEVEL, SWIPE_ROW_PX, SWIPE_STOP } from "./swipe";

export type SpringParams = {
  /** kg-ish: more mass = slower, more momentum. */
  mass: number;
  /** N/m-ish: pull toward rest. */
  stiffness: number;
  /** N·s/m-ish: friction against velocity. */
  damping: number;
};

/** ζ: < 1 bounces, 1 is critical (fastest with no overshoot), > 1 creeps. */
export const dampingRatio = (p: SpringParams) => p.damping / (2 * Math.sqrt(p.stiffness * p.mass));

/** Undamped angular frequency ω₀ = √(k/m), rad/s. */
export const naturalFrequency = (p: SpringParams) => Math.sqrt(p.stiffness / p.mass);

/**
 * Position and velocity, t seconds on, of a spring at rest at 0 that starts at
 * x0 with velocity v0 (units per second). Exact.
 */
export function springAt(x0: number, v0: number, p: SpringParams, t: number) {
  const w = naturalFrequency(p);
  const z = dampingRatio(p);
  if (Math.abs(z - 1) < 1e-4) {
    const e = Math.exp(-w * t);
    return { x: (x0 + (v0 + w * x0) * t) * e, v: (v0 - w * (v0 + w * x0) * t) * e };
  }
  if (z < 1) {
    const a = z * w;
    const wd = w * Math.sqrt(1 - z * z);
    const e = Math.exp(-a * t);
    const B = (v0 + a * x0) / wd;
    const c = Math.cos(wd * t);
    const s = Math.sin(wd * t);
    return { x: e * (x0 * c + B * s), v: e * (v0 * c - (x0 * wd + a * B) * s) };
  }
  const q = Math.sqrt(z * z - 1);
  const r1 = -w * (z - q);
  const r2 = -w * (z + q);
  const c2 = (v0 - r1 * x0) / (r2 - r1);
  const c1 = x0 - c2;
  const e1 = Math.exp(r1 * t);
  const e2 = Math.exp(r2 * t);
  return { x: c1 * e1 + c2 * e2, v: r1 * c1 * e1 + r2 * c2 * e2 };
}

/** One step toward `goal` over dt seconds (for a goal that moves, e.g. the finger). */
export function springStep(x: number, v: number, goal: number, dt: number, p: SpringParams) {
  const s = springAt(x - goal, v, p, dt);
  return { x: goal + s.x, v: s.v };
}

/** A spring is at rest within half a pixel, moving under 10 px/s. */
export const REST_PX = 0.5;
export const REST_V = 10;

/** Seconds until the spring from (x0, v0) stays at rest (REST_PX, REST_V); capped at `max`. */
export function springSettle(x0: number, v0: number, p: SpringParams, max = 3) {
  const dt = 1 / 240;
  let last = 0;
  for (let t = 0; t <= max; t += dt) {
    const s = springAt(x0, v0, p, t);
    if (Math.abs(s.x) > REST_PX || Math.abs(s.v) > REST_V) last = t + dt;
  }
  return Math.min(max, last);
}

/** How far a fling at v0 (per second) coasts under friction k (1/s) before it stops. */
export const flingDistance = (v0: number, k: number) => (k > 0 ? v0 / k : 0);

/** A fling's position and velocity, t seconds after release from x0 at v0. */
export function flingAt(x0: number, v0: number, k: number, t: number) {
  if (k <= 0) return { x: x0, v: 0 };
  const e = Math.exp(-k * t);
  return { x: x0 + (v0 / k) * (1 - e), v: v0 * e };
}

/** Seconds a fling at v0 takes to slow to vEnd under friction k. */
export const flingSeconds = (v0: number, vEnd: number, k: number) =>
  k > 0 && Math.abs(v0) > Math.abs(vEnd) ? Math.log(Math.abs(v0) / Math.abs(vEnd)) / k : 0;

/**
 * The rubber band: `x` of travel past a limit shows as this much, never
 * reaching `d`. `c` is the stiffness of the band (iOS uses 0.55): smaller
 * is heavier. Odd: a negative x gives the mirror image.
 */
export function rubberBand(x: number, d: number, c: number) {
  if (d <= 0 || c <= 0) return 0;
  const f = Math.abs(x);
  return Math.sign(x) * (1 - 1 / ((f * c) / d + 1)) * d;
}

/** The feel tokens the physics reads (a subset of SwipeFeel, lib/words/swipe-feel.ts). */
export type PhysicsFeel = SpringParams & {
  /** How strongly a level holds (snapDetent's snap). */
  snap: number;
  /** Past the last level, the share of the finger followed (when rubberBand is 0). */
  stretch: number;
  /** Past the last level, the rubber band's stiffness; 0 = the linear stretch. */
  rubberBand: number;
  /** The share of the release velocity that carries into the coast, 0..1. */
  flingCarry: number;
  /** Friction on that coast, 1/s. */
  friction: number;
  /** The fastest coast, px/s. */
  maxFling: number;
};

/**
 * Where the row sits for a finger travel: the snapping staircase over the
 * levels (unchanged thresholds), then past the last level either the linear
 * stretch to a hard stop, or a rubber band that eases into that stop.
 */
export function followSwipe(finger: number, f: PhysicsFeel, a = SWIPE_ROW_PX) {
  const cell = SWIPE_LEVEL * a;
  const top = SWIPE_MAX_LEVEL * cell;
  const stop = SWIPE_STOP * a;
  const abs = Math.abs(finger);
  if (f.rubberBand > 0 && abs > top) {
    const lastX = SWIPE_MAX_LEVEL * a;
    return Math.sign(finger) * (lastX + rubberBand(abs - top, stop - lastX, f.rubberBand));
  }
  return snapDetent(finger, {
    cell,
    unit: a,
    max: SWIPE_MAX_LEVEL,
    snap: f.snap,
    stretch: f.stretch,
    stop,
  });
}

export type Trajectory = {
  /** Seconds from release to rest. */
  seconds: number;
  /** Position at t seconds (0 = home). */
  at: (t: number) => number;
  /** The farthest the row gets, px from home (signed). */
  peak: number;
};

/**
 * The release path from x0 (px from home) at velocity v (px/s): the share
 * `flingCarry` of v coasts on under friction until it is slow, then the
 * spring takes it home from there, velocity and all. Past `limit` the coast
 * meets a rubber band, so a hard fling never leaves the row's reach.
 */
export function releaseTrajectory(
  x0: number,
  v: number,
  f: PhysicsFeel,
  limit = SWIPE_STOP * SWIPE_ROW_PX,
): Trajectory {
  const v0 = Math.max(-f.maxFling, Math.min(f.maxFling, v * f.flingCarry));
  const coastable = f.friction > 0 && Math.abs(v0) > 0;
  // Coast until the velocity is a sixth of the spring's own pace at that point.
  const vEnd = Math.max(REST_V * 6, Math.abs(v0) * 0.15);
  const tc = coastable ? flingSeconds(v0, vEnd, f.friction) : 0;
  const end = coastable ? flingAt(x0, v0, f.friction, tc) : { x: x0, v: 0 };
  const band = Math.max(1, limit * 0.15);
  const soft = (x: number) =>
    Math.abs(x) <= limit ? x : Math.sign(x) * (limit + rubberBand(Math.abs(x) - limit, band, 0.55));
  const ts = springSettle(end.x, end.v, f);
  const at = (t: number) => {
    if (t <= 0) return x0;
    if (t < tc) return soft(flingAt(x0, v0, f.friction, t).x);
    if (t >= tc + ts) return 0;
    return soft(springAt(end.x, end.v, f, t - tc).x);
  };
  let peak = x0;
  const seconds = tc + ts;
  for (let i = 0; i <= 120; i++) {
    const x = at((seconds * i) / 120);
    if (Math.abs(x) > Math.abs(peak)) peak = x;
  }
  return { seconds, at, peak };
}

/**
 * The trajectory as a CSS easing for a transition from translateX(x0) to
 * translateX(0): progress p = 1 − x/x0 (it may pass 1, or go below 0 while
 * the row coasts out). Null when x0 is too small to scale by.
 */
export function trajectoryEasing(tr: Trajectory, x0: number, n = 48): string | null {
  if (Math.abs(x0) < 0.5 || tr.seconds <= 0) return null;
  const pts = Array.from({ length: n + 1 }, (_, i) =>
    i === n ? 1 : +(1 - tr.at((tr.seconds * i) / n) / x0).toFixed(4),
  );
  return `linear(${pts.join(", ")})`;
}
