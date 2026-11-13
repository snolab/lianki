/**
 * The sentence being read aloud, swept left to right over the time it
 * should take (owner, 2026-11-14): its highlight fills like a progress bar
 * following the voice. Client-only, in memory.
 *
 * The timing comes from the voice session (voice.ts `onTiming`): a clip's
 * length over its speed (voice-out.ts clipTiming), or an estimate from the
 * characters for speechSynthesis (voice.ts speechMs). This file keeps, for
 * the sentence playing now, when it started and how long it should take:
 *
 * - `start`: a sentence began; no length yet (a static highlight until one comes);
 * - `timing`: its length, as of `at` (`done` already behind it). A later,
 *   better one restarts the sweep from where it is now (a negative delay);
 * - `pause` / `resume`: the reading waits (a barge-in, a tap): the sweep holds
 *   (animation-play-state), and goes on from there.
 *
 * Each restart bumps `v`, the element's key: React never changes a running
 * animation's timing in place (a changed delay would jump it).
 */

export type Sweep = {
  /** Bumped at each (re)start of the sweep: the speaking span's key. */
  v: number;
  /** When the sweep was at 0 (ms, the page clock), paused time left out. */
  start: number;
  /** The whole sentence's expected reading time (ms); null: unknown, a static highlight. */
  dur: number | null;
  /** The animation's delay (ms, ≤ 0): how far along it was when (re)started. */
  delay: number;
  /** Since when the reading waits; null while it plays. */
  pausedAt: number | null;
};
export type SweepEvent =
  | { type: "start"; at: number }
  | { type: "timing"; at: number; ms: number; done: number }
  | { type: "pause"; at: number }
  | { type: "resume"; at: number };

export const initialSweep = (): Sweep => ({ v: 0, start: 0, dur: null, delay: 0, pausedAt: null });

/** A `done` share this close to the end is taken as this, so the whole is never infinite. */
const DONE_MAX = 0.99;

export function sweepStep(s: Sweep, ev: SweepEvent): Sweep {
  switch (ev.type) {
    case "start":
      return { v: s.v + 1, start: ev.at, dur: null, delay: 0, pausedAt: null };
    case "timing": {
      if (!(ev.ms > 0) || !Number.isFinite(ev.ms)) return s;
      const done = Math.min(DONE_MAX, Math.max(0, ev.done || 0));
      const dur = ev.ms / (1 - done);
      const delay = -Math.round(done * dur) || 0;
      return {
        v: s.v + 1,
        start: ev.at + delay,
        dur: Math.round(dur),
        delay,
        pausedAt: s.pausedAt === null ? null : ev.at,
      };
    }
    case "pause":
      return s.pausedAt === null ? { ...s, pausedAt: ev.at } : s;
    case "resume":
      return s.pausedAt === null
        ? s
        : { ...s, start: s.start + Math.max(0, ev.at - s.pausedAt), pausedAt: null };
  }
}

/** How far the sweep is at `now` (0–1); null while its length is unknown. */
export function sweepFraction(s: Sweep, now: number): number | null {
  if (s.dur === null) return null;
  const t = (s.pausedAt ?? now) - s.start;
  return Math.min(1, Math.max(0, t / s.dur));
}

/** The keyframes' name (READ_SWEEP_CSS). */
export const SWEEP_NAME = "lk-read-sweep";
/** Set on the sweeping span, for the reduced-motion rules. */
export const SWEEP_ATTR = "data-lk-sweep";

/** The part already read: a stronger tint (light and dark). */
const FILLED = "light-dark(oklch(0.86 0.1 90 / 0.85), oklch(0.44 0.09 22.3 / 0.85))";
/** The part still to read: the soft highlight, lighter. */
const UNFILLED = "light-dark(oklch(0.95 0.035 90 / 0.6), oklch(0.3 0.04 22.3 / 0.55))";
/** The static highlight (reduced motion, or no length known): the earlier soft one. */
export const SPEAKING_BG = "light-dark(oklch(0.92 0.06 90 / 0.7), oklch(0.36 0.055 22.3 / 0.7))";
const flat = (c: string) => `linear-gradient(${c}, ${c})`;
/** Filled layer over the unfilled one; only the first grows. */
const SIZES = (filled: string) => `${filled} 100%, 100% 100%`;

/**
 * The keyframes, and no sweep under prefers-reduced-motion or the app's
 * "Turn off animations" (`data-motion="off"`): the static highlight instead.
 * Its own stylesheet, since the hot-loaded widget has no app one.
 */
export const READ_SWEEP_CSS =
  `@keyframes ${SWEEP_NAME}{from{background-size:${SIZES("0%")}}to{background-size:${SIZES("100%")}}}` +
  `@media (prefers-reduced-motion: reduce){[${SWEEP_ATTR}]{animation:none!important;background:${SPEAKING_BG}!important}}` +
  `html[data-motion="off"] [${SWEEP_ATTR}]{animation:none!important;background:${SPEAKING_BG}!important}`;

/** The speaking span's style: the sweep over `dur`, held while paused; null without a length. */
export function sweepStyle(s: Sweep): Record<string, string | number> | null {
  if (s.dur === null) return null;
  return {
    backgroundImage: `${flat(FILLED)}, ${flat(UNFILLED)}`,
    backgroundRepeat: "no-repeat",
    backgroundSize: SIZES("0%"),
    // Wrapped lines: the background runs on from one line's end to the next one's start.
    boxDecorationBreak: "slice",
    WebkitBoxDecorationBreak: "slice",
    borderRadius: 3,
    animationName: SWEEP_NAME,
    animationDuration: `${s.dur}ms`,
    animationTimingFunction: "linear",
    animationDelay: `${s.delay}ms`,
    animationIterationCount: 1,
    animationFillMode: "both",
    animationPlayState: s.pausedAt === null ? "running" : "paused",
  };
}
