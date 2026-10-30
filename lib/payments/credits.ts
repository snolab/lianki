/**
 * Prepaid credits — a wallet balance in JPY, the rules side (no I/O).
 *
 * Modelled on wallets like renzhe.cloud's: top up once through any payment
 * method, then spend the balance on passes; a pass bought with the balance
 * activates at once, with no payment page in between. The D1 side is
 * `credits-store.ts`, the tables `db/migrations/0017_credits.sql`.
 */
import { PASSES } from "./passes";

/** Smallest and largest single top-up, in JPY. */
export const TOPUP_MIN = 100;
export const TOPUP_MAX = 10_000;

/** One-tap amounts: the two passes, and multiples that cover them. */
export const QUICK_TOPUPS = [600, 1200, 3000, 5000] as const;

export type CreditReason = "topup" | "pass" | "refund" | "gift" | "sponsor" | "adjust";

/** The reasons the owner may use for a manual entry from /dev/credits. */
export const ADMIN_REASONS = ["sponsor", "adjust", "gift"] as const satisfies CreditReason[];
export type AdminReason = (typeof ADMIN_REASONS)[number];

/** Largest single manual entry (either sign), a typo guard. */
export const ADMIN_MAX = 100_000;

/** A valid top-up amount (a whole number of yen in range), or null. */
export function topupAmount(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= TOPUP_MIN && n <= TOPUP_MAX
    ? n
    : null;
}

/**
 * How much more the user must top up to afford `price`, rounded up to the
 * smallest top-up (a ¥30 gap still needs a ¥100 top-up). 0 when affordable.
 */
export function shortfall(balance: number, price: number): number {
  const missing = price - balance;
  return missing <= 0 ? 0 : Math.max(missing, TOPUP_MIN);
}

/** Client-supplied idempotency key for a spend: a UUID-ish token, or null. */
export function spendKey(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

/** The product name on the provider's checkout page and receipt. */
export function topupName(amount: number): string {
  return `Lianki credits — ¥${amount.toLocaleString("en-US")}`;
}

/** Sanity check that the quick amounts stay buyable and cover each pass. */
export function quickTopupsCoverPasses(): boolean {
  return (
    QUICK_TOPUPS.every((a) => topupAmount(a) === a) &&
    Object.values(PASSES).every((p) => QUICK_TOPUPS.some((a) => a === p.amount))
  );
}
