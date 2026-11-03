/**
 * The /words picker's stats (app/(app)/words/WordsStats.tsx): pure helpers
 * for the study heatmap and the headline numbers. Days are the reader's local
 * calendar days, as YYYY-MM-DD keys (en-CA), built with local Date arithmetic
 * so a DST change never skips or doubles a day.
 */

/** Weeks the heatmap shows: about six months. */
export const STATS_WEEKS = 26;
/** Days the server reads: the whole grid, whichever weekday today is. */
export const STATS_DAYS = STATS_WEEKS * 7;

/** One row from GET /api/words/stats: day, list id, words graded, new words. */
export type StatsTuple = [day: string, listId: string, words: number, fresh: number];

export type DayStats = { words: number; fresh: number };

export const dayKey = (d: Date): string => d.toLocaleDateString("en-CA");

/** `day` moved by `n` local days (YYYY-MM-DD in, YYYY-MM-DD out). */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n));
}

/** The reader's UTC offset in minutes east (JST 540): the server's fallback. */
export const tzOffset = (d = new Date()): number => -d.getTimezoneOffset();

/** The reader's IANA time zone ("Asia/Tokyo"), so the server buckets each day exactly. */
export const tzName = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
};

/** Until `until` (exclusive, ISO; null = open), the zone is `offset` minutes east. */
export type OffsetSpan = { until: string | null; offset: number };

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** `tz`'s UTC offset at `at`, minutes east; null for an unknown zone. */
export function zoneOffset(tz: string, at: Date): number | null {
  let f = offsetFormats.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" });
    } catch {
      return null;
    }
    offsetFormats.set(tz, f);
  }
  const name = f.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return name === "GMT" ? 0 : null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/**
 * `tz`'s offsets between `since` and `now`, split at each change (DST), so a
 * review is bucketed by the offset its own day had, not today's. Scans a day
 * at a time and finds each change to the minute; null for an unknown zone.
 */
export function offsetSpans(tz: string, since: Date, now: Date): OffsetSpan[] | null {
  const DAY = 86_400_000;
  const MIN = 60_000;
  let prev = zoneOffset(tz, since);
  if (prev === null) return null;
  const spans: OffsetSpan[] = [];
  for (let t = since.getTime() + DAY; ; t += DAY) {
    const at = Math.min(t, now.getTime());
    const off = zoneOffset(tz, new Date(at))!;
    if (off !== prev) {
      // The change lies in (at - DAY, at]: narrow it to the minute.
      let lo = at - DAY;
      let hi = at;
      while (hi - lo > MIN) {
        const mid = lo + Math.max(1, Math.floor((hi - lo) / 2 / MIN)) * MIN;
        if (zoneOffset(tz, new Date(mid)) === prev) lo = mid;
        else hi = mid;
      }
      spans.push({ until: new Date(hi).toISOString(), offset: prev });
      prev = off;
    }
    if (at >= now.getTime()) break;
  }
  spans.push({ until: null, offset: prev });
  return spans;
}

/** Per-day totals over the lists shown (other pages' lists, e.g. alphabets, left out). */
export function sumByDay(rows: StatsTuple[], listIds?: Set<string>): Map<string, DayStats> {
  const out = new Map<string, DayStats>();
  for (const [day, list, words, fresh] of rows) {
    if (listIds && !listIds.has(list)) continue;
    const d = out.get(day) ?? { words: 0, fresh: 0 };
    d.words += words;
    d.fresh += fresh;
    out.set(day, d);
  }
  return out;
}

/**
 * Days in a row with study, ending today; a day not yet studied today does
 * not break it (counted up to yesterday then).
 */
export function streak(days: Map<string, DayStats>, today = new Date()): number {
  const at = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!(days.get(dayKey(at))?.words ?? 0)) at.setDate(at.getDate() - 1);
  let n = 0;
  while ((days.get(dayKey(at))?.words ?? 0) > 0) {
    n++;
    at.setDate(at.getDate() - 1);
  }
  return n;
}

/**
 * The grid, GitHub-style: columns are weeks (Sunday first), the last column
 * holds today. Days after today are null.
 */
export function gridWeeks(today = new Date(), weeks = STATS_WEEKS): (string | null)[][] {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - start.getDay() - (weeks - 1) * 7);
  const end = dayKey(today);
  const out: (string | null)[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: (string | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const at = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      const k = dayKey(at);
      col.push(k <= end ? k : null);
    }
    out.push(col);
  }
  return out;
}

/**
 * Ink level 0..steps of a day's mark, against the reader's own busy days (the
 * 90th percentile of studied days), so a light learner's grid is not all faint
 * and a heavy one's not all full. 4 steps for the seals, ink and notches; 5
 * for the strokes of 正.
 */
export function inkScale(days: Map<string, DayStats>, steps = 4): (words: number) => number {
  const counts = [...days.values()]
    .map((d) => d.words)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const top = counts.length
    ? counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.9))]
    : 1;
  return (words) => {
    if (words <= 0) return 0;
    return Math.min(steps, Math.max(1, Math.ceil((steps * words) / Math.max(1, top))));
  };
}

/** A small, stable tilt per day (degrees), so the seals look stamped by hand. */
export function sealTilt(day: string): number {
  let h = 0;
  for (let i = 0; i < day.length; i++) h = (h * 31 + day.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 11) - 5) * 1.2;
}

/* ---------------------------------------------------------------------------
 * New users (owner, 2026-11-03 22:39 JST): variants of the grid while the
 * owner picks one. No span is fixed for a user; each comes from his history:
 *
 *  - "full"   the six-month grid as before (the default until he picks).
 *  - "grow"   (A) only as many weeks as he has history, growing with it.
 *  - "today"  (B) no grid while history is too short to mean anything
 *             (`tooShort`); today against his own usual day, and his streak.
 *  - "ahead"  (C) the days still to come this period drawn as faint cells.
 *  - "grow-ahead" A and C together.
 * ------------------------------------------------------------------------- */

export const VARIANTS = ["full", "grow", "today", "ahead", "grow-ahead"] as const;
export type Variant = (typeof VARIANTS)[number];

/** Days in one column of the grid: a week, one row per weekday. */
export const WEEK = 7;

/** Days with any study. */
export const activeDays = (days: Map<string, DayStats>): string[] =>
  [...days.entries()]
    .filter(([, v]) => v.words > 0)
    .map(([d]) => d)
    .sort();

/**
 * Too little history for a grid to mean anything: fewer studied days than a
 * grid column has cells (a week). Before that not one column could be full,
 * so the grid cannot show a rhythm yet, only a few scattered marks.
 */
export const tooShort = (days: Map<string, DayStats>): boolean => activeDays(days).length < WEEK;

/** Sunday of `day`'s week (the grid's columns start on Sunday). */
export function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return shiftDay(day, -new Date(y, m - 1, d).getDay());
}

/** Whole weeks from `from`'s week to `to`'s, both counted. */
export function weeksBetween(from: string, to: string): number {
  const a = weekStart(from).split("-").map(Number);
  const b = weekStart(to).split("-").map(Number);
  const ms = Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2]);
  return Math.round(ms / 86_400_000 / WEEK) + 1;
}

/**
 * The end of the period the faint "ahead" cells run to: the Saturday that
 * closes the week holding the last day of this month. A calendar month is
 * the period everyone shares; no goal of ours is put on him.
 */
export function periodEnd(today: string): string {
  const [y, m] = today.split("-").map(Number);
  const last = dayKey(new Date(y, m, 0));
  return shiftDay(weekStart(last), WEEK - 1);
}

/**
 * The grid's columns for a variant: weeks of day keys, Sunday first. Days
 * after `today` are future cells (C draws them faint; the others leave them
 * blank). Never more than the data read (`max` weeks).
 *  - full: the `max` weeks ending this week, as before.
 *  - grow: from the week of the first studied day to this week (one week
 *    with no history yet).
 *  - ahead: `max` weeks ending at the period's end.
 *  - grow-ahead: from the first studied week to the period's end.
 *  - today: as full (it shows no grid only while history is too short).
 */
export function gridFor(
  variant: Variant,
  days: Map<string, DayStats>,
  today: string,
  max = STATS_WEEKS,
): string[][] {
  const grow = variant === "grow" || variant === "grow-ahead";
  const ahead = variant === "ahead" || variant === "grow-ahead";
  const end = ahead ? periodEnd(today) : shiftDay(weekStart(today), WEEK - 1);
  const first = activeDays(days).find((d) => d <= today) ?? today;
  const want = grow ? weeksBetween(first, end) : max;
  const n = Math.max(1, Math.min(max, want));
  const start = shiftDay(weekStart(end), -(n - 1) * WEEK);
  return Array.from({ length: n }, (_, w) =>
    Array.from({ length: WEEK }, (_, d) => shiftDay(start, w * WEEK + d)),
  );
}

/**
 * Today against his own usual day: words studied today, and the mean over
 * the earlier days he studied (in the data read). `ratio` is today / usual;
 * null usual on his first day, when there is nothing to compare with.
 */
export function todayVsUsual(
  days: Map<string, DayStats>,
  today: string,
): { today: number; usual: number | null; ratio: number | null } {
  const now = days.get(today)?.words ?? 0;
  const before = activeDays(days).filter((d) => d < today);
  if (!before.length) return { today: now, usual: null, ratio: null };
  const usual = before.reduce((s, d) => s + days.get(d)!.words, 0) / before.length;
  return { today: now, usual, ratio: now / usual };
}

/**
 * The owner's "simulate a new user" view: his own rows cut to the last `n`
 * days (today counted), so each variant can be seen with real data. Client
 * side only; nothing is written.
 */
export function simulateHistory(rows: StatsTuple[], today: string, n: number): StatsTuple[] {
  const from = shiftDay(today, -(n - 1));
  return rows.filter(([d]) => d >= from && d <= today);
}
