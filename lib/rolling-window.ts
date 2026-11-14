/**
 * Rolling-window usage counters: amounts kept in hourly buckets keyed by the
 * UTC hour (hours since the epoch), summed over the last N hours. A cap over
 * such a window frees up gradually as old hours fall out; no calendar day and
 * no time zone appears anywhere (owner, 2026-11-15: mature AI services reset
 * by rolling windows, not by a day in some zone).
 *
 * The window is the current hour plus the N − 1 hours before it, so an amount
 * leaves the sum between N − 1 and N hours after it was used.
 *
 * Imports nothing: the debug hub (lianki-push) uses it too.
 */

export const HOUR_MS = 3_600_000;

/** Hour index (whole UTC hours since the epoch) → amount used in that hour. */
export type HourBuckets = Record<string, number>;

/** The UTC hour bucket an epoch-ms time falls in. */
export const hourOf = (t: number) => Math.floor(t / HOUR_MS);

/** Whether bucket `hour` is still inside a window of `hours` ending at `nowHour`. */
export const inWindow = (hour: number, nowHour: number, hours: number) =>
  hour > nowHour - hours && hour <= nowHour;

/** The buckets still inside the window (older ones dropped; future ones kept). */
export function pruneBuckets(b: HourBuckets | undefined, nowHour: number, hours: number) {
  const out: HourBuckets = {};
  for (const [k, v] of Object.entries(b ?? {})) {
    const h = Number(k);
    if (Number.isFinite(h) && h > nowHour - hours && typeof v === "number" && v > 0) out[k] = v;
  }
  return out;
}

/** The total used over the window of `hours` ending at `nowHour`. */
export function windowSum(b: HourBuckets | undefined, nowHour: number, hours: number) {
  let sum = 0;
  for (const [k, v] of Object.entries(b ?? {}))
    if (typeof v === "number" && inWindow(Number(k), nowHour, hours)) sum += v;
  return sum;
}

/** `b` with `delta` added to bucket `hour` (never below zero; an empty bucket is removed). */
export function addToBucket(b: HourBuckets | undefined, hour: number, delta: number) {
  const out: HourBuckets = { ...b };
  const v = Math.max(0, (out[hour] ?? 0) + delta);
  if (v > 0) out[hour] = v;
  else delete out[hour];
  return out;
}

/** A configured window length in hours: a whole number in [1, max], else the default. */
export function windowHours(v: unknown, dflt: number, max: number) {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? Math.min(v, max) : dflt;
}

/**
 * When `need` more fits under `cap` again: the epoch ms at which enough of the
 * oldest buckets have left the window (a bucket for hour h leaves at the
 * start of hour h + hours). `now` when it fits already; null when even an
 * empty window could not hold it.
 */
export function fitsAgainAt(
  b: HourBuckets | undefined,
  now: number,
  hours: number,
  cap: number,
  need: number,
): number | null {
  if (need > cap) return null;
  const nowHour = hourOf(now);
  let sum = windowSum(b, nowHour, hours);
  if (sum + need <= cap) return now;
  const live = Object.entries(b ?? {})
    .map(([k, v]) => [Number(k), v] as const)
    .filter(([h, v]) => typeof v === "number" && inWindow(h, nowHour, hours))
    .sort((x, y) => x[0] - y[0]);
  // Drop the oldest until it fits (it does once all are gone: need ≤ cap).
  let i = 0;
  while (sum + need > cap) sum -= live[i++]![1];
  return (live[i - 1]![0] + hours) * HOUR_MS;
}
