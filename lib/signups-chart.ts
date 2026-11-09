/**
 * Monthly sign-ups for the owner's /dev/users chart: calendar months in JST,
 * the current month's forecast, and the bar geometry the SVG draws. Pure, so
 * the bucketing and the forecast are unit-tested without a page.
 */

/** JST is UTC+9 all year (no daylight saving). */
const JST_MS = 9 * 3_600_000;

/** "2026-11": the JST calendar month an instant falls in. */
export function jstMonth(d: Date | string | number): string {
  return new Date(new Date(d).getTime() + JST_MS).toISOString().slice(0, 7);
}

/** Days in a "YYYY-MM" month (28–31; leap Februaries are 29). */
export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The month `n` months after (or before, if negative) a "YYYY-MM" month. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * The whole month at the pace so far: so far × days in month ÷ days elapsed,
 * where today (JST) counts as an elapsed day. Day 1 → so far × days in month;
 * the last day → so far.
 */
export function forecastMonth(soFar: number, now: Date | number = Date.now()) {
  const month = jstMonth(now);
  const elapsed = new Date(new Date(now).getTime() + JST_MS).getUTCDate();
  const days = daysInMonth(month);
  return { month, elapsed, days, forecast: Math.round((soFar * days) / elapsed) };
}

export type MonthCount = { month: string; n: number };
export type MonthBar = MonthCount & {
  /** Only on the current month: the whole-month estimate (≥ n). */
  forecast?: number;
};

/**
 * Every month from the first sign-up (at most `span` months back) to the
 * current JST month, with zero for months nobody joined. Rows from the query
 * outside that window are dropped.
 */
export function monthSeries(rows: MonthCount[], now: Date | number = Date.now(), span = 24) {
  const current = jstMonth(now);
  const counts = new Map(rows.map((r) => [r.month, r.n]));
  const earliest = rows.reduce((a, r) => (r.month < a ? r.month : a), current);
  const floor = addMonths(current, -(span - 1));
  const start = earliest > floor ? earliest : floor;
  const out: MonthBar[] = [];
  for (let m = start; m <= current; m = addMonths(m, 1)) {
    out.push({ month: m, n: counts.get(m) ?? 0 });
  }
  const last = out[out.length - 1];
  last.forecast = Math.max(last.n, forecastMonth(last.n, now).forecast);
  return out;
}

/** A round axis top: 1, 2, 5 × 10^k, at least `v` (and at least 1). */
export function niceMax(v: number): number {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  // p ≤ v < 10p, so 10 always fits.
  return [1, 2, 5, 10].find((f) => f * p >= v)! * p;
}

/** The readout for one bar: count, or "so far · forecast" on the current month. */
export function barText(b: MonthBar, c: { barDone: string; barCurrent: string }): string {
  const t = b.forecast === undefined ? c.barDone : c.barCurrent;
  return t
    .replace("{month}", b.month)
    .replace("{count}", String(b.n))
    .replace("{forecast}", String(b.forecast ?? b.n));
}

export const CHART = { slot: 28, bar: 18, height: 160, top: 12, bottom: 34, left: 6 } as const;

export type BarGeom = MonthBar & {
  x: number;
  /** Top of the solid bar and its height. */
  y: number;
  h: number;
  /** The hatched forecast extension above the solid bar (current month only). */
  fy?: number;
  fh?: number;
  /**
   * Text under the bar: the month number, with the year on January and on the
   * first bar (unless a January follows within two bars, where they would collide).
   */
  label: string;
  year?: string;
};

/** Bars, axis ticks and the SVG size for a series. */
export function chartModel(series: MonthBar[]) {
  const { slot, bar, height, top, bottom, left } = CHART;
  const plot = height - top - bottom;
  const max = niceMax(Math.max(0, ...series.map((b) => Math.max(b.n, b.forecast ?? 0))));
  const yOf = (v: number) => top + plot - (v / max) * plot;
  const bars: BarGeom[] = series.map((b, i) => {
    const x = left + i * slot + (slot - bar) / 2;
    const y = yOf(b.n);
    const g: BarGeom = { ...b, x, y, h: top + plot - y, label: b.month.slice(5) };
    if (g.label === "01" || (i === 0 && g.label < "11")) g.year = b.month.slice(0, 4);
    if (b.forecast !== undefined && b.forecast > b.n) {
      g.fy = yOf(b.forecast);
      g.fh = y - g.fy;
    }
    return g;
  });
  const ticks = (max % 2 ? [0, max] : [0, max / 2, max]).map((v) => ({ v, y: yOf(v) }));
  return { bars, ticks, max, width: left + series.length * slot + 4, height, base: top + plot };
}
