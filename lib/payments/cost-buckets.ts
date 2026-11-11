/**
 * Costs per JST day and per JST hour, by feature (docs/payments.md, "Cost
 * ledger", "Day and hour matrices"; owner, 2026-11-11). The same two sides as
 * `costSummary`: free from `cost_ledger`, paid from settled `credit_ai_charge`
 * rows (by `settledAt`), the feature from the charge key's prefix.
 *
 * - Buckets are JST (UTC+9, no daylight saving): a day is `YYYY-MM-DD`, an
 *   hour `YYYY-MM-DDTHH`. Every bucket of the window is listed, empty ones
 *   too, so a chart's time axis has no holes.
 * - The hourly window is capped (`COSTS_MAX_HOURS`) and bounded by both the
 *   indexed `day` column and the stored ISO times, so its query stays cheap.
 * - The aggregation (`costMatrix`) is pure and unit-tested.
 */
import type { D1Like } from "@/lib/d1/types";
import { CREDITS_PER_USD } from "./credits";
import {
  COST_DAY_OFFSET_MS,
  costDay,
  paidFeature,
  type CostRange,
  type CostTotals,
} from "./cost-ledger";
import { MARGIN } from "./prices";

/** The default hourly window: the last 48 JST hours, this one included. */
export const COSTS_DEFAULT_HOURS = 48;
/** The widest hourly window one request may ask for (7 days). */
export const COSTS_MAX_HOURS = 168;

const HOUR = 3600_000;
const OFFSET_H = COST_DAY_OFFSET_MS / HOUR;

/** The JST hour of `at`: `YYYY-MM-DDTHH`. */
export const costHour = (at: Date) =>
  new Date(at.getTime() + COST_DAY_OFFSET_MS).toISOString().slice(0, 13);

/** The start (UTC ms) of the JST hour `YYYY-MM-DDTHH`. */
export const hourStartMs = (hour: string) => Date.parse(`${hour}:00:00Z`) - COST_DAY_OFFSET_MS;

/** Every JST day from `from` to `to`, inclusive, oldest first. */
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
  /** The hours, oldest first (`YYYY-MM-DDTHH`, JST). */
  hours: string[];
  /** UTC ISO bounds: start inclusive, end exclusive. */
  startIso: string;
  endIso: string;
  /** The JST days the window touches (for the indexed `day` bound). */
  fromDay: string;
  toDay: string;
};

/**
 * The last `count` JST hours of `range` (at most `COSTS_MAX_HOURS`), not after
 * the hour that holds `now` and not before the range's first day.
 */
export function hourWindow(count: number, range: CostRange, now = new Date()): HourWindow {
  const n = Math.max(1, Math.min(COSTS_MAX_HOURS, Math.floor(count) || COSTS_DEFAULT_HOURS));
  const endOfTo = Date.parse(`${range.to}T23:00:00Z`) - COST_DAY_OFFSET_MS;
  const startOfFrom = Date.parse(`${range.from}T00:00:00Z`) - COST_DAY_OFFSET_MS;
  const last = Math.max(startOfFrom, Math.min(hourStartMs(costHour(now)), endOfTo));
  const first = Math.max(startOfFrom, last - (n - 1) * HOUR);
  const len = (last - first) / HOUR + 1;
  const hours = Array.from({ length: len }, (_, i) => costHour(new Date(first + i * HOUR)));
  return {
    hours,
    startIso: new Date(first).toISOString(),
    endIso: new Date(last + HOUR).toISOString(),
    fromDay: costDay(new Date(first)),
    toDay: costDay(new Date(last)),
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
const JST_DAY = (col: string) => `date(${col}, '+${OFFSET_H} hours')`;
const JST_HOUR = (col: string) => `strftime('%Y-%m-%dT%H', ${col}, '+${OFFSET_H} hours')`;

/** Day × feature over `range` (JST days, inclusive). */
export async function costDayMatrix(d1: D1Like, range: CostRange) {
  const [free, paid] = await Promise.all([
    d1
      .prepare(
        "SELECT day AS b, feature, SUM(usd_micro) AS micro, COUNT(*) AS n FROM cost_ledger WHERE day BETWEEN ? AND ? GROUP BY day, feature",
      )
      .bind(range.from, range.to)
      .all<FreeGroup>(),
    d1
      .prepare(
        `SELECT ${JST_DAY("settledAt")} AS b, ${PREFIX} AS prefix, SUM(costMicro) AS cm, COUNT(*) AS n FROM credit_ai_charge WHERE status = 'settled' AND ${JST_DAY("settledAt")} BETWEEN ? AND ? GROUP BY b, prefix`,
      )
      .bind(range.from, range.to)
      .all<PaidGroup>(),
  ]);
  return { range, ...costMatrix(dayBuckets(range), free.results, paid.results) };
}

/** Hour × feature over `w` (JST hours). Bounded by the indexed day / settledAt columns. */
export async function costHourMatrix(d1: D1Like, w: HourWindow) {
  const [free, paid] = await Promise.all([
    d1
      .prepare(
        `SELECT ${JST_HOUR("at")} AS b, feature, SUM(usd_micro) AS micro, COUNT(*) AS n FROM cost_ledger WHERE day BETWEEN ? AND ? AND at >= ? AND at < ? GROUP BY b, feature`,
      )
      .bind(w.fromDay, w.toDay, w.startIso, w.endIso)
      .all<FreeGroup>(),
    d1
      .prepare(
        `SELECT ${JST_HOUR("settledAt")} AS b, ${PREFIX} AS prefix, SUM(costMicro) AS cm, COUNT(*) AS n FROM credit_ai_charge WHERE status = 'settled' AND settledAt >= ? AND settledAt < ? GROUP BY b, prefix`,
      )
      .bind(w.startIso, w.endIso)
      .all<PaidGroup>(),
  ]);
  return {
    window: { hours: w.hours.length, from: w.hours[0], to: w.hours[w.hours.length - 1] },
    ...costMatrix(w.hours, free.results, paid.results),
  };
}
