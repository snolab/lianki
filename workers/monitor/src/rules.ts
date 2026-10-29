/**
 * When the monitor speaks up. Pure functions, so the thresholds are tested
 * (unit/monitor-rules.test.ts) apart from the Worker plumbing.
 */

/** Real requests: alert when this many errors land within the window. */
export const ERROR_BURST = 3;
/** Real requests slower than this (wall ms) count as slow. */
export const REAL_SLOW_MS = 5000;
/** Real requests: alert when this many slow ones land within the window. */
export const SLOW_BURST = 5;
export const WINDOW_MS = 10 * 60_000;
/** The same alert at most this often. */
export const REPEAT_MS = 30 * 60_000;

/** Timestamps within the window ending at `now`, with `at` added. */
export function inWindow(times: number[], at: number, now: number): number[] {
  return [...times.filter((t) => now - t < WINDOW_MS), at];
}

/** Group a URL path for metrics: ids and long tokens collapse so paths aggregate. */
export function pathGroup(url: string): string {
  let p: string;
  try {
    p = new URL(url).pathname;
  } catch {
    return "?";
  }
  return (
    p
      .split("/")
      .map((seg) => (/^[0-9a-f-]{16,}$|^\d+$/i.test(seg) ? ":id" : seg))
      .join("/")
      .slice(0, 80) || "/"
  );
}

/** Seconds, one decimal. */
export const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** A burst that was alerted on is over: nothing within the window before `now`. */
export function quiet(times: number[], now: number): boolean {
  return times.every((t) => now - t >= WINDOW_MS);
}
