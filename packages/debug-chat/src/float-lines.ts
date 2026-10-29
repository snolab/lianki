/**
 * The minimized chat's floating lines: a message that arrives while the chat is
 * minimized floats above the bar for as long as it takes to read it twice,
 * then fades. Hovering or touching the lines pauses their timers.
 */

/** Characters per second read in CJK scripts (Han, kana, Hangul). */
export const READ_RATE_CJK = 6;
/** Characters per second for everything else (~180 words per minute). */
export const READ_RATE_LATIN = 15;
/** A line stays up for this many reading times... */
export const DWELL_FACTOR = 2;
/** ...and never less than this. */
export const DWELL_MIN_MS = 2_500;
/** The fade-out once the dwell is over (instant under reduced motion). */
export const FADE_MS = 400;
/** At most this many lines float at once; the oldest goes first. */
export const FLOAT_MAX = 6;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Seconds to read `text` once: CJK characters at 6/s, the rest at 15/s. */
export function readTime(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text.trim()) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return cjk / READ_RATE_CJK + other / READ_RATE_LATIN;
}

/** How long a floating line stays before it fades, in ms. */
export function dwellMs(text: string): number {
  return Math.max(DWELL_MIN_MS, Math.round(readTime(text) * 1000 * DWELL_FACTOR));
}

/**
 * One line's countdown: a single setTimeout, stopped by `pause` and restarted
 * by `resume` with the time that was left. Clock and timers are injected for
 * tests.
 */
export function createDwellTimer(d: {
  ms: number;
  onDone: () => void;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const now = d.now ?? (() => Date.now());
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let left = d.ms;
  let started = now();
  let timer: unknown = null;
  let done = false;
  const start = () => {
    started = now();
    timer = setTimer(() => {
      timer = null;
      done = true;
      d.onDone();
    }, left);
  };
  start();
  return {
    pause() {
      if (timer === null || done) return;
      clearTimer(timer);
      timer = null;
      left = Math.max(0, left - (now() - started));
    },
    resume() {
      if (timer !== null || done) return;
      start();
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      done = true;
    },
    /** The time left, in ms (frozen while paused). */
    remaining: () => (timer === null ? left : Math.max(0, left - (now() - started))),
  };
}
