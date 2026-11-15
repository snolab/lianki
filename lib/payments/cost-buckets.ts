/**
 * Costs per day and per hour, by feature, in the viewer's time zone (docs/payments.md,
 * "Cost ledger", "Day and hour matrices"; owner, 2026-11-11). The same two
 * sides as `costSummary`: free from `cost_ledger`, paid from settled
 * `credit_ai_charge` rows (by `settledAt`), the feature from the charge key's prefix.
 *
 * - Buckets are in the viewer's zone, given as a fixed offset `offMin`
 *   (minutes east of UTC; 0 = UTC, the default): a day is `YYYY-MM-DD`, an
 *   hour `YYYY-MM-DDTHH`. Every bucket of the window is listed, empty ones
 *   too, so a chart's time axis has no holes.
 * - The hourly window is capped (`COSTS_MAX_HOURS`) and bounded by both the
 *   indexed `day` column and the stored ISO times, so its query stays cheap.
 * - The aggregation (`costMatrix`) is pure and unit-tested.
 */
import type { D1Like } from "@/lib/d1/types";
import { localDay, localHour } from "@/lib/time-zone";
import { CREDITS_PER_USD } from "./credits";
import {
  paidFeature,
  rangeBounds,
  sqlDay,
  sqlHour,
  type CostRange,
  type CostTotals,
} from "./cost-ledger";
import { MARGIN } from "./prices";

/** The default hourly window: the last 48 hours, this one included. */
export const COSTS_DEFAULT_HOURS = 48;
/** The widest hourly window one request may ask for (7 days). */
export const COSTS_MAX_HOURS = 168;

const HOUR = 3600_000;

/** The hour of `at` at offset `offMin`: `YYYY-MM-DDTHH`. */
export const costHour = (at: Date, offMin = 0) => localHour(at, offMin);

/** The start (UTC ms) of the hour `YYYY-MM-DDTHH` at offset `offMin`. */
export const hourStartMs = (hour: string, offMin = 0) =>
  Date.parse(`${hour}:00:00Z`) - offMin * 60_000;

/** Every day from `from` to `to`, inclusive, oldest first. */
export function dayBuckets({ from, to }: CostRange): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); ; t += 86400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > to) break;
    out.push(d);
  }
  return out;
}

export type HourWindow = {
  /** The hours, oldest first (`YYYY-MM-DDTHH`, at `offMin`). */
  hours: string[];
  /** UTC ISO bounds: start inclusive, end exclusive. */
  startIso: string;
  endIso: string;
  /** The `cost_ledger.day` bounds for the index (a day wider each side). */
  fromDay: string;
  toDay: string;
  /** The viewer's offset the hours are in, minutes east of UTC. */
  offMin: number;
};

/**
 * The last `count` hours of `range` (at most `COSTS_MAX_HOURS`), not after
 * the hour that holds `now` and not before the range's first day; in the
 * viewer's zone at offset `offMin`.
 */
export function hourWindow(
  count: number,
  range: CostRange,
  now = new Date(),
  offMin = 0,
): HourWindow {
  const n = Math.max(1, Math.min(COSTS_MAX_HOURS, Math.floor(count) || COSTS_DEFAULT_HOURS));
  const endOfTo = hourStartMs(`${range.to}T23`, offMin);
  const startOfFrom = hourStartMs(`${range.from}T00`, offMin);
  const last = Math.max(startOfFrom, Math.min(hourStartMs(costHour(now, offMin), offMin), endOfTo));
  const first = Math.max(startOfFrom, last - (n - 1) * HOUR);
  const len = (last - first) / HOUR + 1;
  const hours = Array.from({ length: len }, (_, i) => costHour(new Date(first + i * HOUR), offMin));
  return {
    hours,
    startIso: new Date(first).toISOString(),
    endIso: new Date(last + HOUR).toISOString(),
    fromDay: localDay(first - 86400_000),
    toDay: localDay(last + 86400_000),
    offMin,
  };
}

/** One free-side group: bucket, feature, provider cost (USD micro), calls. */
export type FreeGroup = { b: string; feature: string; micro: number | null; n: number };
/** One paid-side group: bucket, charge key prefix, costMicro (credit micro), calls. */
export type PaidGroup = { b: string; prefix: string | null; cm: number | null; n: number };

export type MatrixRow = {
  bucket: string;
  /** Sums over every feature of this bucket. */
  total: CostTotals;
  /** Per feature; a feature with nothing in this bucket is absent. */
  cells: Record<string, CostTotals>;
};

export type CostMatrix = {
  /** Every bucket of the window, oldest first. */
  rows: MatrixRow[];
  /** The column sums, the dearest feature first. */
  features: ({ feature: string } & CostTotals)[];
  totals: CostTotals;
};

const zero = (): CostTotals => ({
  freeMicro: 0,
  freeCalls: 0,
  paidMicro: 0,
  paidCredits: 0,
  paidCalls: 0,
});
const add = (t: CostTotals, x: CostTotals) => {
  t.freeMicro += x.freeMicro;
  t.freeCalls += x.freeCalls;
  t.paidMicro += x.paidMicro;
  t.paidCredits += x.paidCredits;
  t.paidCalls += x.paidCalls;
};
export const costOf = (t: CostTotals) => t.freeMicro + t.paidMicro;

/**
 * Buckets × features from the grouped rows of both sides. Groups outside
 * `buckets` are dropped (the window decides); empty buckets stay as rows.
 */
export function costMatrix(buckets: string[], free: FreeGroup[], paid: PaidGroup[]): CostMatrix {
  const byBucket = new Map<string, MatrixRow>(
    buckets.map((b) => [b, { bucket: b, total: zero(), cells: {} }]),
  );
  const cols = new Map<string, CostTotals>();
  const totals = zero();
  const put = (b: string, feature: string, x: CostTotals) => {
    const row = byBucket.get(b);
    if (!row) return;
    add((row.cells[feature] ??= zero()), x);
    add(row.total, x);
    let col = cols.get(feature);
    if (!col) cols.set(feature, (col = zero()));
    add(col, x);
    add(totals, x);
  };
  for (const r of free) put(r.b, r.feature, { ...zero(), freeMicro: r.micro ?? 0, freeCalls: r.n });
  for (const r of paid) {
    const cm = r.cm ?? 0;
    put(r.b, paidFeature(r.prefix), {
      ...zero(),
      paidMicro: cm / CREDITS_PER_USD / MARGIN,
      paidCredits: cm / 1e6,
      paidCalls: r.n,
    });
  }
  return {
    rows: buckets.map((b) => byBucket.get(b)!),
    features: [...cols]
      .map(([feature, t]) => ({ feature, ...t }))
      .sort((a, b) => costOf(b) - costOf(a) || a.feature.localeCompare(b.feature)),
    totals,
  };
}

const PREFIX = "CASE WHEN instr(key, ':') > 0 THEN substr(key, 1, instr(key, ':') - 1) ELSE '' END";

/** Day × feature over `range` (days at offset `offMin`, inclusive). */
export async function costDayMatrix(d1: D1Like, range: CostRange, offMin = 0) {
  const b = rangeBounds(range, offMin);
  const [free, paid] = await Promise.all([
    d1
      .prepare(
        `SELECT ${sqlDay("at", offMin)} AS b, feature, SUM(usd_micro) AS micro, COUNT(*) AS n FROM cost_ledger WHERE day BETWEEN ? AND ? AND at >= ? AND at < ? GROUP BY b, feature`,
      )
      .bind(b.fromDay, b.toDay, b.startIso, b.endIso)
      .all<FreeGroup>(),
    d1
      .prepare(
        `SELECT ${sqlDay("settledAt", offMin)} AS b, ${PREFIX} AS prefix, SUM(costMicro) AS cm, COUNT(*) AS n FROM credit_ai_charge WHERE status = 'settled' AND settledAt >= ? AND settledAt < ? GROUP BY b, prefix`,
      )
      .bind(b.startIso, b.endIso)
      .all<PaidGroup>(),
  ]);
  return { range, ...costMatrix(dayBuckets(range), free.results, paid.results) };
}

/** Hour × feature over `w` (hours at `w.offMin`). Bounded by the indexed day / settledAt columns. */
export async function costHourMatrix(d1: D1Like, w: HourWindow) {
  const [free, paid] = await Promise.all([
    d1
      .prepare(
        `SELECT ${sqlHour("at", w.offMin)} AS b, feature, SUM(usd_micro) AS micro, COUNT(*) AS n FROM cost_ledger WHERE day BETWEEN ? AND ? AND at >= ? AND at < ? GROUP BY b, feature`,
      )
      .bind(w.fromDay, w.toDay, w.startIso, w.endIso)
      .all<FreeGroup>(),
    d1
      .prepare(
        `SELECT ${sqlHour("settledAt", w.offMin)} AS b, ${PREFIX} AS prefix, SUM(costMicro) AS cm, COUNT(*) AS n FROM credit_ai_charge WHERE status = 'settled' AND settledAt >= ? AND settledAt < ? GROUP BY b, prefix`,
      )
      .bind(w.startIso, w.endIso)
      .all<PaidGroup>(),
  ]);
  return {
    window: { hours: w.hours.length, from: w.hours[0], to: w.hours[w.hours.length - 1] },
    ...costMatrix(w.hours, free.results, paid.results),
  };
}
