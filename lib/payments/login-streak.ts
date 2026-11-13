/**
 * Login-streak bonus — the rules side (no I/O). Owner decision 2026-11-14:
 * credits for consecutive days of real learning (a card reviewed, a reader
 * grade), paid once per calendar day in the learner's home time zone.
 *
 * - A **cycle** of day rewards (default 7: day 1 … day 7), then it repeats:
 *   streak day 8 is paid as cycle step 1 again. The amounts and so the cycle
 *   length are the config key `credits.loginStreak.usdByDay`.
 * - A **missed day never resets** the streak outright: each missed calendar
 *   day costs `credits.loginStreak.missCostDays` streak days (default 2, the
 *   conservative choice; 0 = misses are free, a large value ≈ a full reset).
 *   The streak is never below 0 before the day that is being counted.
 * - A day counts once: the ledger refId is `streak:<userId>:<day>`.
 *
 * The D1 side is `login-streak-store.ts`; docs/payments.md, "Login-streak bonus".
 */
import { CONFIG } from "@/lib/config";
import { CREDITS_PER_USD } from "./credits";

export interface StreakConfig {
  /** USD per cycle step, step 1 first; the length is the cycle. */
  usdByDay: number[];
  /** Streak days one missed calendar day costs. */
  missCostDays: number;
}

/** `credits.loginStreak.usdByDay` text → amounts; an unreadable entry reads as 0. */
export function parseUsdByDay(text: string): number[] {
  const out = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
  return out.length ? out : [0];
}

/** The defaults of the `credits.loginStreak.*` keys (tests, and the shape). */
export const STREAK_DEFAULTS: StreakConfig = {
  usdByDay: parseUsdByDay(CONFIG["credits.loginStreak.usdByDay"].default),
  missCostDays: CONFIG["credits.loginStreak.missCostDays"].default,
};

/** Whole credits for a USD amount (the ledger holds integers). */
export function usdToCredits(usd: number): number {
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * CREDITS_PER_USD) : 0;
}

/** The ledger refId of one day's grant: UNIQUE with reason `gift`, so once per day. */
export function streakRefId(userId: string, day: string): string {
  return `streak:${userId}:${day}`;
}

/** The local day (YYYY-MM-DD) a ledger refId stands for, or null when it is not a streak grant. */
export function streakDayOf(refId: string | null | undefined): string | null {
  const m = /^streak:.+:(\d{4}-\d{2}-\d{2})$/.exec(refId ?? "");
  return m ? m[1]! : null;
}

/**
 * A grant's note, `login streak day <step> (<streak>)`: the cycle step paid
 * and the streak length that day, or null when the note is not a streak grant's.
 */
export function streakNoteOf(
  note: string | null | undefined,
): { step: number; streak: number } | null {
  const m = /^login streak day (\d+) \((\d+)\)/.exec(note ?? "");
  return m ? { step: Number(m[1]), streak: Number(m[2]) } : null;
}

/** The cycle step (1-based) a grant's note names. */
export function streakStepOf(note: string | null | undefined): number | null {
  return streakNoteOf(note)?.step ?? null;
}

const DAY_MS = 86_400_000;

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD, the same zone); NaN when unreadable. */
export function daysBetween(from: string, to: string): number {
  const ms = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  return Math.round((ms(to) - ms(from)) / DAY_MS);
}

/** The cycle step of a streak length under `conf` (1 … cycle). */
export function cycleStep(streak: number, conf: StreakConfig): number {
  const cycle = Math.max(1, conf.usdByDay.length);
  return ((Math.max(1, streak) - 1) % cycle) + 1;
}

/** The credits paid on a cycle step (0 when that step pays nothing). */
export function stepCredits(step: number, conf: StreakConfig): number {
  return usdToCredits(conf.usdByDay[step - 1] ?? 0);
}

export interface StreakState {
  /** The last day that counted (YYYY-MM-DD in the home zone). */
  day: string;
  /** Consecutive days as of `day`. */
  streak: number;
}

export interface StreakStep {
  /** The streak after counting `today`. */
  streak: number;
  /** Its cycle step and that step's credits. */
  step: number;
  credits: number;
  /** Calendar days missed since the last counted day (0 when consecutive). */
  missed: number;
}

/**
 * What counting `today` does to the streak, or null when there is nothing to
 * do: `today` is already the counted day, or lies before it (a clock or zone
 * oddity — never count backwards), or is unreadable.
 */
export function nextStreak(
  prev: StreakState | null,
  today: string,
  conf: StreakConfig,
): StreakStep | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  let missed = 0;
  let base = 0;
  if (prev) {
    const gap = daysBetween(prev.day, today);
    if (!Number.isFinite(gap) || gap <= 0) return null;
    missed = gap - 1;
    const cost = Math.max(0, conf.missCostDays);
    base = Math.max(0, prev.streak - missed * cost);
  }
  const streak = base + 1;
  const step = cycleStep(streak, conf);
  return { streak, step, credits: stepCredits(step, conf), missed };
}

/**
 * The streak a learner holds as seen on `today` before learning: the stored
 * streak when the last counted day is today or yesterday, otherwise what the
 * miss rule leaves of it (what the next counted day builds on).
 */
export function currentStreak(prev: StreakState | null, today: string, conf: StreakConfig): number {
  if (!prev) return 0;
  const gap = daysBetween(prev.day, today);
  if (!Number.isFinite(gap) || gap <= 1) return prev.streak;
  return Math.max(0, prev.streak - (gap - 1) * Math.max(0, conf.missCostDays));
}
