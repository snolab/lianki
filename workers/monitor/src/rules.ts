/**
 * When the monitor speaks up. Pure functions, so the thresholds are tested
 * (unit/monitor-rules.test.ts) apart from the Worker plumbing.
 */

/** A synthetic probe slower than this counts as slow (ms, to response headers). */
export const PROBE_SLOW_MS = 3000;
/** Consecutive bad probes of one path before alerting — one cold start is not an outage. */
export const PROBE_STRIKES = 2;
/** Real requests: alert when this many errors land within the window. */
export const ERROR_BURST = 3;
/** Real requests slower than this (wall ms) count as slow. */
export const REAL_SLOW_MS = 5000;
/** Real requests: alert when this many slow ones land within the window. */
export const SLOW_BURST = 5;
export const WINDOW_MS = 10 * 60_000;
/** The same alert at most this often. */
export const REPEAT_MS = 30 * 60_000;

export type Probe = { path: string; status: number; ms: number; error?: string };

export function probeBad(p: Probe): string | null {
  if (p.error) return `failed: ${p.error}`;
  if (p.status >= 500) return `HTTP ${p.status}`;
  if (p.ms > PROBE_SLOW_MS) return `slow: ${(p.ms / 1000).toFixed(1)}s`;
  return null;
}

/** A path's run of bad probes: the next strike count, and whether to alert or announce recovery. */
export function nextStrikes(
  strikes: number,
  bad: boolean,
): { strikes: number; alert: boolean; recovered: boolean } {
  if (!bad) return { strikes: 0, alert: false, recovered: strikes >= PROBE_STRIKES };
  const n = strikes + 1;
  return { strikes: n, alert: n === PROBE_STRIKES, recovered: false };
}

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
