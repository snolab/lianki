/**
 * How many reviews fall due on each local day — the load the partner plans
 * around (docs/calendar-plan.md, "FSRS due load").
 *
 * Counts cards already scheduled: page notes (`fsrs_notes`) and word cards
 * (`word_cards`), bucketed by the user's local days. Overdue cards count on
 * today. Day boundaries are exact UTC instants computed per day, so DST days
 * (23 or 25 hours) are right; each table is one query with a CASE over the
 * boundaries (at most MAX_DAYS + 1 bound parameters, under D1's 100).
 *
 * Limitation: a card reviewed tomorrow comes back later, which this does not
 * predict (a later phase simulates that with ts-fsrs).
 */
import type { D1Like } from "@/lib/d1/types";
import { addDays, dayStartUtc, localDay } from "@/lib/tree/tz";

export const MAX_DAYS = 60;
/** Seconds a word review takes when the user has no measured pace yet. */
export const DEFAULT_SECONDS_PER_WORD = 8;
/** Seconds a page review takes, until watch stats give a better figure. */
export const SECONDS_PER_PAGE = 120;

export type DayLoad = { day: string; pages: number; words: number; estMinutes: number };

export type DueLoad = {
  tz: string;
  days: DayLoad[];
  pace: { secondsPerWord: number; secondsPerPage: number };
};

type Bucket = { upper: string; idx: number };

/**
 * Upper bounds (exclusive, UTC ISO) of each day's bucket. Days before today get
 * none (their cards are overdue and count on today); today's bucket starts at
 * the beginning of time.
 */
function buckets(
  tz: string,
  from: string,
  n: number,
  now: Date,
): { list: Bucket[]; lower: string } {
  const today = localDay(tz, now);
  const list: Bucket[] = [];
  for (let i = 0; i < n; i++) {
    const day = addDays(from, i);
    if (day < today) continue;
    list.push({ upper: dayStartUtc(tz, addDays(day, 1)).toISOString(), idx: i });
  }
  // Below the first counted bucket: everything (overdue) when today is in range,
  // otherwise that day's own start.
  const first = list[0];
  const firstDay = first ? addDays(from, first.idx) : from;
  const lower = firstDay === today ? "" : dayStartUtc(tz, firstDay).toISOString();
  return { list, lower };
}

async function countByDay(
  db: D1Like,
  table: "fsrs_notes" | "word_cards",
  email: string,
  b: { list: Bucket[]; lower: string },
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!b.list.length) return out;
  const cases = b.list.map((x) => `WHEN card_due < ? THEN ${x.idx}`).join(" ");
  const live = table === "fsrs_notes" ? " AND deleted_at IS NULL" : "";
  const sql = `SELECT CASE ${cases} END AS d, COUNT(*) AS n FROM ${table}
     WHERE email = ?${live} AND card_due >= ? AND card_due < ?
     GROUP BY d`;
  const last = b.list[b.list.length - 1].upper;
  const { results } = await db
    .prepare(sql)
    .bind(...b.list.map((x) => x.upper), email, b.lower, last)
    .all<{ d: number; n: number }>();
  for (const r of results) if (r.d != null) out.set(Number(r.d), Number(r.n));
  return out;
}

/** Median seconds per word review over the last 30 days, or the default. */
export async function secondsPerWord(db: D1Like, email: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT elapsed_ms FROM word_reviews
       WHERE email = ? AND reviewed_at >= ? AND elapsed_ms > 0
       ORDER BY reviewed_at DESC LIMIT 2000`,
    )
    .bind(email, since)
    .all<{ elapsed_ms: number }>();
  if (results.length < 10) return DEFAULT_SECONDS_PER_WORD;
  const ms = results.map((r) => Number(r.elapsed_ms)).sort((a, b) => a - b);
  const mid = ms.length >> 1;
  const median = ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2;
  // A row left on screen for minutes is not a review pace; keep it sane.
  return Math.min(60, Math.max(2, Math.round(median / 100) / 10));
}

/** The due load per local day, `days` days from `from` (YYYY-MM-DD) in `tz`. */
export async function dueLoad(
  db: D1Like,
  opts: { email: string; tz: string; from: string; days: number; now?: Date },
): Promise<DueLoad> {
  const now = opts.now ?? new Date();
  const n = Math.max(1, Math.min(MAX_DAYS, Math.floor(opts.days)));
  const b = buckets(opts.tz, opts.from, n, now);
  const [pages, words, spw] = await Promise.all([
    countByDay(db, "fsrs_notes", opts.email, b),
    countByDay(db, "word_cards", opts.email, b),
    secondsPerWord(db, opts.email, now),
  ]);
  const days: DayLoad[] = [];
  for (let i = 0; i < n; i++) {
    const p = pages.get(i) ?? 0;
    const w = words.get(i) ?? 0;
    days.push({
      day: addDays(opts.from, i),
      pages: p,
      words: w,
      estMinutes: Math.round((w * spw + p * SECONDS_PER_PAGE) / 60),
    });
  }
  return { tz: opts.tz, days, pace: { secondsPerWord: spw, secondsPerPage: SECONDS_PER_PAGE } };
}
