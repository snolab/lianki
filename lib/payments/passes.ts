/**
 * Prepaid Pro passes: a one-time payment that pushes `proEndsAt` forward.
 *
 * One-time rather than a subscription because Stripe takes Alipay and WeChat
 * Pay only as one-time payments — a pass is how those buyers get Pro at all.
 * Priced in JPY: the account settles in JPY, so a JPY price has no 2% FX fee.
 */
export type PassId = "pro-1m" | "pro-12m";

export interface Pass {
  id: PassId;
  /** Days of Pro the pass adds. */
  days: number;
  /** Price in JPY (JPY has no minor unit: 600 is ¥600). */
  amount: number;
  currency: "jpy";
  /** Product name shown on Stripe Checkout and the receipt. */
  name: string;
}

export const PASSES: Record<PassId, Pass> = {
  "pro-1m": { id: "pro-1m", days: 31, amount: 600, currency: "jpy", name: "Lianki Pro — 1 month" },
  "pro-12m": {
    id: "pro-12m",
    days: 366,
    amount: 5000,
    currency: "jpy",
    name: "Lianki Pro — 12 months",
  },
};

export function passFor(id: unknown): Pass | null {
  return typeof id === "string" && Object.hasOwn(PASSES, id) ? PASSES[id as PassId] : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The expiry after buying `days` more: added to the current expiry while Pro
 * is still running, so renewing early never loses days; from now otherwise.
 */
export function extendedProEnd(current: Date | undefined, days: number, now = new Date()): Date {
  const base = current && current > now ? current : now;
  return new Date(base.getTime() + days * DAY_MS);
}
