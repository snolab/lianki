/**
 * Study days and the learner level they lead to (docs/levels.md, lib/levels.ts).
 *
 * Owner rules, Slack 2026-11-05: progress after paying is cumulative study
 * days — not a streak — and must be hard to fake:
 * - only reviews the server records count, and the day is cut by the
 *   server's clock in the user's time zone (Cloudflare's, from the request),
 *   so a changed device clock or an offline review sent later adds no day;
 * - a review counts only if its card was on screen at least human reaction
 *   time (the 1–3 s common-knowledge range; its lower end), so mass-tapped
 *   grades do not count;
 * - one count per day however many reviews; never more days than have passed
 *   since the first paid day; tied to the account (not transferable).
 */
import { CONFIG } from "@/lib/config";
import { cfRequestProps } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { flagOn } from "@/lib/flags-store";
import type { D1WithBatch } from "@/lib/payments/credits-store";
import { recordLoginStreak } from "@/lib/payments/login-streak-store";
import { LEVELS, type Level, type LevelId, type LevelTier } from "@/lib/levels";

/**
 * The lower end of human reaction time (1–3 s): faster than this is not a
 * read. The default of config `study.humanReactionMs`; callers pass the live
 * value (`cfg`, lib/config-store.ts; docs/config-store.md).
 */
export const HUMAN_REACTION_MS: number = CONFIG["study.humanReactionMs"].default;

const DAY_MS = 86_400_000;

/** On screen long enough to have been read: measured and at least reaction time (`minMs`). */
export function qualifies(
  onScreenMs: number | null | undefined,
  minMs: number = HUMAN_REACTION_MS,
): boolean {
  return typeof onScreenMs === "number" && onScreenMs >= minMs;
}

/** The local calendar day of `at` in `tz` (YYYY-MM-DD); UTC when the zone is unknown. */
export function localDay(at: Date, tz: string | null | undefined): { day: string; tz: string } {
  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  if (tz)
    try {
      return { day: fmt(tz), tz };
    } catch {
      // not an IANA zone: UTC
    }
  return { day: fmt("UTC"), tz: "UTC" };
}

/** The time zone Cloudflare places this request in (from its IP), if any. */
export function requestTimeZone(): string | undefined {
  const tz = (cfRequestProps() as { timezone?: unknown } | undefined)?.timezone;
  return typeof tz === "string" && tz ? tz : undefined;
}

/**
 * The local day of `now` for `email`: in the home zone — the one the first
 * study day was cut in — so hopping zones (a VPN, a trip) cannot split one
 * real day into two local dates; a new account takes the request's zone
 * (`tz`), and UTC when there is none.
 */
export async function homeDay(
  d1: D1Like,
  email: string,
  now: Date,
  tz: string | null | undefined,
): Promise<{ day: string; tz: string }> {
  const home = await d1
    .prepare("SELECT tz FROM study_day WHERE email = ? ORDER BY first_at LIMIT 1")
    .bind(email.toLowerCase())
    .first<{ tz: string }>();
  return localDay(now, home?.tz ?? tz);
}

/**
 * Record `qualifying` reviews the server just stored for `email`, on today's
 * local day by the server clock `now`, in the user's home zone (`tz` only
 * until there is one). A no-op for 0. Idempotent per day:
 * the row counts reviews, the day counts once.
 */
export async function recordStudy(
  d1: D1Like,
  email: string,
  qualifying: number,
  now: Date,
  tz: string | null | undefined,
): Promise<StudyDayWrite | null> {
  if (!email || !(qualifying > 0)) return null;
  const key = email.toLowerCase();
  const d = await homeDay(d1, email, now, tz);
  await d1
    .prepare(
      `INSERT INTO study_day (email, day, tz, first_at, reviews) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email, day) DO UPDATE SET reviews = reviews + excluded.reviews`,
    )
    .bind(key, d.day, d.tz, now.toISOString(), Math.floor(qualifying))
    .run();
  // Whether this write opened the day: the row's first_at is ours. (Two
  // concurrent first writes see one of them as first; the other skips — the
  // streak grant is idempotent anyway.)
  const row = await d1
    .prepare("SELECT first_at FROM study_day WHERE email = ? AND day = ?")
    .bind(key, d.day)
    .first<{ first_at: string }>();
  return { day: d.day, tz: d.tz, first: row?.first_at === now.toISOString() };
}

/** What `recordStudy` wrote: the local day, its zone, and whether this write opened the day. */
export type StudyDayWrite = { day: string; tz: string; first: boolean };

/**
 * What follows the first qualifying action of a day (`recordStudySafe`):
 * the login-streak bonus (lib/payments/login-streak-store.ts; docs/payments.md,
 * "Login-streak bonus"). Injected in tests; the default reads the flag
 * `credits.login-streak` and grants over the same D1.
 */
export interface StudyDayHooks {
  /** Whether the streak bonus is on (fail closed, like every flag). */
  streakOn: () => Promise<boolean>;
  /** Count `day` for the account behind `email` and pay its step. */
  streak: (d1: D1Like, email: string, day: string, tz: string, now: Date) => Promise<unknown>;
}

const defaultHooks: StudyDayHooks = {
  streakOn: () => flagOn("credits.login-streak"),
  streak: async (d1, email, day, tz, now) => {
    const user = await d1
      .prepare("SELECT id FROM user WHERE lower(email) = lower(?)")
      .bind(email)
      .first<{ id: string }>();
    if (!user) return;
    await recordLoginStreak(d1 as D1WithBatch, user.id, day, tz, now);
  },
};

/**
 * `recordStudy` for a request handler: never fails the review it follows
 * (the review is already stored); a failure is logged.
 */
export async function recordStudySafe(
  d1: D1Like,
  email: string | null | undefined,
  qualifying: number,
  now: Date,
  hooks: StudyDayHooks = defaultHooks,
): Promise<void> {
  if (!email || !(qualifying > 0)) return;
  let wrote: StudyDayWrite | null = null;
  try {
    wrote = await recordStudy(d1, email, qualifying, now, requestTimeZone());
  } catch (err) {
    console.error("study-days: record failed", err);
  }
  // The day's first real learning action counts for the login streak — only
  // then, so later reviews of the day cost nothing. Never fails the review.
  if (!wrote?.first) return;
  try {
    if (await hooks.streakOn()) await hooks.streak(d1, email, wrote.day, wrote.tz, now);
  } catch (err) {
    console.error("login-streak: grant failed", err);
  }
}

/** Study days since `since` (server time), never more than the days that have passed. */
export async function studyDaysSince(
  d1: D1Like,
  email: string,
  since: Date,
  now: Date,
): Promise<number> {
  const row = await d1
    .prepare(
      "SELECT COUNT(*) AS n FROM study_day WHERE email = ? AND first_at >= ? AND first_at <= ?",
    )
    .bind(email.toLowerCase(), since.toISOString(), now.toISOString())
    .first<{ n: number }>();
  return capDays(Number(row?.n ?? 0), since, now);
}

/** At most one study day per calendar day passed since `since`, the first included. */
export function capDays(counted: number, since: Date, now: Date): number {
  const passed = Math.floor((now.getTime() - since.getTime()) / DAY_MS) + 1;
  return Math.max(0, Math.min(counted, passed));
}

/**
 * The first day of the paid tier: the earliest Pro bought (a live payment or
 * a pass bought with credits) or given (sponsor, gift, referral). Null when
 * the user never had Pro.
 */
export async function paidSince(d1: D1Like, userId: string): Promise<Date | null> {
  const row = await d1
    .prepare(
      `SELECT MIN(at) AS at FROM (
         SELECT createdAt AS at FROM payment WHERE userId = ?1 AND testMode = 0
         UNION ALL
         SELECT createdAt FROM credit_ledger WHERE userId = ?1 AND reason = 'pass' AND amount < 0
         UNION ALL
         SELECT createdAt FROM membership_grant WHERE userId = ?1 AND kind = 'pro' AND days > 0
       )`,
    )
    .bind(userId)
    .first<{ at: string | null }>();
  const t = row?.at ? Date.parse(row.at) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

/** The level a user is at: guest, free, paid, then by study days after paying. */
export function levelFor(s: { signedIn: boolean; paid: boolean; studyDays: number }): Level {
  const tier: LevelTier = !s.signedIn ? "guest" : s.paid ? "paid" : "free";
  let at = LEVELS.find((l) => l.tier === tier)!;
  if (tier === "paid")
    for (const l of LEVELS) if (l.unlock === "progress" && s.studyDays >= l.studyDays!) at = l;
  return at;
}

export type UserLevel = {
  level: LevelId;
  tier: LevelTier;
  paidSince: string | null;
  studyDays: number;
  /** The next level reached by study days, and how many it needs; null at the top or off the paid tier. */
  next: { level: LevelId; studyDays: number } | null;
};

/** A user's level from D1. `user` null = a guest. */
export async function userLevel(
  d1: D1Like,
  user: { id: string; email: string; proEndsAt?: Date | null } | null,
  now = new Date(),
): Promise<UserLevel> {
  if (!user) return { level: "lv1", tier: "guest", paidSince: null, studyDays: 0, next: null };
  const paid = !!user.proEndsAt && user.proEndsAt > now;
  const since = await paidSince(d1, user.id);
  const studyDays = since ? await studyDaysSince(d1, user.email, since, now) : 0;
  const l = levelFor({ signedIn: true, paid: paid && !!since, studyDays });
  const next =
    l.tier === "paid" ? (LEVELS.find((x) => x.rank === l.rank + 1 && x.studyDays) ?? null) : null;
  return {
    level: l.id,
    tier: l.tier,
    paidSince: since?.toISOString() ?? null,
    studyDays,
    next: next ? { level: next.id, studyDays: next.studyDays! } : null,
  };
}

/** `userLevel` for a signed-in email (null = guest), reading the user row from D1. */
export async function userLevelOf(
  d1: D1Like,
  email: string | null | undefined,
  now = new Date(),
): Promise<UserLevel> {
  if (!email) return userLevel(d1, null, now);
  const row = await d1
    .prepare("SELECT id, email, proEndsAt FROM user WHERE lower(email) = lower(?)")
    .bind(email)
    .first<{ id: string; email: string; proEndsAt: string | null }>();
  // Signed in, but no user row (should not happen): a free account.
  if (!row) return { level: "lv2", tier: "free", paidSince: null, studyDays: 0, next: null };
  const pro = row.proEndsAt ? new Date(row.proEndsAt) : null;
  return userLevel(d1, { id: row.id, email: row.email, proEndsAt: pro }, now);
}

export type StudyDayRow = { day: string; tz: string; first_at: string; reviews: number };

/** The last `n` study days of `email`, newest first (the owner's debug view). */
export async function recentStudyDays(d1: D1Like, email: string, n = 14): Promise<StudyDayRow[]> {
  const { results } = await d1
    .prepare(
      "SELECT day, tz, first_at, reviews FROM study_day WHERE email = ? ORDER BY first_at DESC LIMIT ?",
    )
    .bind(email.toLowerCase(), n)
    .all<StudyDayRow>();
  return results;
}
