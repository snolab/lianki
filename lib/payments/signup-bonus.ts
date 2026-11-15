/**
 * Sign-up bonus — the rules side (no I/O). Owner decision 2026-11-15: every
 * new account gets US$1 of credits once, but only the first 10 new accounts
 * of each **UTC** day; accounts that existed before the feature get the same
 * one-time bonus on their next sign-in or wallet read, outside the cap.
 *
 * The D1 side is `signup-bonus-store.ts`; docs/payments.md, "Sign-up bonus".
 */
import { CONFIG } from "@/lib/config";
import { usdToCredits } from "./login-streak";

export interface SignupBonusConfig {
  /** USD per account (`credits.signupBonusUsd`). */
  usd: number;
  /** New accounts per UTC day that get it (`credits.signupBonusDaily`). */
  daily: number;
}

/** The defaults of the `credits.signupBonus*` keys (tests, and the shape). */
export const SIGNUP_BONUS_DEFAULTS: SignupBonusConfig = {
  usd: CONFIG["credits.signupBonusUsd"].default,
  daily: CONFIG["credits.signupBonusDaily"].default,
};

/** The ledger refId of an account's bonus: UNIQUE with reason `gift`, so once per account. */
export function signupBonusRefId(userId: string): string {
  return `signup:${userId}`;
}

/** Whether a ledger refId is a sign-up bonus (new account or backfill). */
export function isSignupBonus(refId: string | null | undefined): boolean {
  return /^signup:./.test(refId ?? "");
}

/** The UTC day (YYYY-MM-DD) the cap counts `now` in. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whole credits the bonus pays under `conf` (0 = nothing to grant). */
export function signupBonusCredits(conf: SignupBonusConfig): number {
  return usdToCredits(conf.usd);
}

/** The day's slot a new account's grant note names (`signup bonus <day> #<n>`), or null. */
export function signupBonusSeqOf(note: string | null | undefined): number | null {
  const m = /^signup bonus \d{4}-\d{2}-\d{2} #(\d+)$/.exec(note ?? "");
  return m ? Number(m[1]) : null;
}
