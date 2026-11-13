/**
 * Account-age bonus — the rules side (no I/O). Owner decision 2026-11-14:
 * every account at least 1 day old gets $1 of credits, and at least 7 days
 * old $2 more ($3 in all). Amounts and ages are config keys
 * (`credits.ageBonus.*`, lib/config.ts); the D1 side is `age-bonus-store.ts`.
 * docs/payments.md, "Account-age bonus".
 */
import { CREDITS_PER_USD } from "./credits";

export const AGE_TIERS = ["d1", "d7"] as const;
export type AgeTier = (typeof AGE_TIERS)[number];

export interface AgeBonusConfig {
  day1Usd: number;
  day7Usd: number;
  day1Hours: number;
  day7Hours: number;
}

/** The defaults of the `credits.ageBonus.*` keys (tests, and the shape). */
export const AGE_BONUS_DEFAULTS: AgeBonusConfig = {
  day1Usd: 1,
  day7Usd: 2,
  day1Hours: 24,
  day7Hours: 168,
};

const HOUR = 60 * 60 * 1000;

/** Whole credits for a USD amount (the ledger holds integers). */
export function usdToCredits(usd: number): number {
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * CREDITS_PER_USD) : 0;
}

/** The ledger refId of one tier's grant: UNIQUE with reason `gift`, so once only. */
export function ageBonusRefId(tier: AgeTier, userId: string): string {
  return `agebonus:${tier}:${userId}`;
}

/** The tier a ledger refId stands for, or null when it is not an age bonus. */
export function ageBonusTier(refId: string | null | undefined): AgeTier | null {
  const m = /^agebonus:(d1|d7):/.exec(refId ?? "");
  return m ? (m[1] as AgeTier) : null;
}

/** An account's createdAt (ISO text in D1, or epoch ms) as epoch ms, or null. */
export function createdAtMs(v: unknown): number | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Each tier's age (hours) and amount (credits) under `conf`. */
export function tierTable(
  conf: AgeBonusConfig,
): { tier: AgeTier; hours: number; credits: number }[] {
  return [
    { tier: "d1", hours: conf.day1Hours, credits: usdToCredits(conf.day1Usd) },
    { tier: "d7", hours: conf.day7Hours, credits: usdToCredits(conf.day7Usd) },
  ];
}

/**
 * The tiers an account is owed now: old enough, a non-zero amount, and not
 * granted yet. An unreadable createdAt owes nothing.
 */
export function tiersOwed(
  createdAt: unknown,
  now: Date,
  conf: AgeBonusConfig,
  granted: Iterable<AgeTier> = [],
): { tier: AgeTier; credits: number }[] {
  const born = createdAtMs(createdAt);
  if (born === null) return [];
  const age = now.getTime() - born;
  const done = new Set(granted);
  return tierTable(conf)
    .filter((t) => t.credits > 0 && !done.has(t.tier) && age >= t.hours * HOUR)
    .map(({ tier, credits }) => ({ tier, credits }));
}

/** The youngest age (hours) at which any tier can be owed — a cheap early exit. */
export function firstTierHours(conf: AgeBonusConfig): number {
  const live = tierTable(conf).filter((t) => t.credits > 0);
  return live.length ? Math.min(...live.map((t) => t.hours)) : Infinity;
}
