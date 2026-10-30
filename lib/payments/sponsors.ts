/**
 * GitHub Sponsors → Lianki Pro: the rules, the billing-period arithmetic and
 * the webhook signature. Pure — the D1 side is `sponsors-store.ts`.
 *
 * GitHub sends no event when a monthly sponsorship renews; it sends
 * `cancelled` when one ends. So a monthly sponsorship counts as paid for every
 * period until then, and each period's Pro is granted once — when a webhook
 * for it arrives, or when the sponsor next reads their membership status.
 */
import { hmacSha256Hex, timingSafeEqual } from "./stripe";

/**
 * Where the membership page sends sponsors. The owner must confirm which
 * GitHub account or organization has Sponsors enabled, and change it here if
 * it is not `snolab`.
 */
export const GITHUB_SPONSORS_URL = "https://github.com/sponsors/snolab";

/** The least a monthly tier must cost to grant Pro: $5. */
export const MONTHLY_MIN_CENTS = 500;

/** Pro is granted through the end of the paid period plus this many days. */
export const GRACE_DAYS = 7;

/**
 * Pro days for a one-time sponsorship, by its price: the largest step at or
 * below the amount applies. Below the first step, nothing.
 */
export const ONE_TIME_DAYS: readonly { minCents: number; days: number }[] = [
  { minCents: 500, days: 30 },
  { minCents: 1000, days: 62 },
  { minCents: 2500, days: 183 },
  { minCents: 5000, days: 366 },
];

/** The `membership_grant.reason` of every sponsorship grant. */
export const SPONSOR_GRANT_REASON = "github-sponsors";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function oneTimeDays(priceCents: number): number {
  let days = 0;
  for (const step of ONE_TIME_DAYS) if (priceCents >= step.minCents) days = step.days;
  return days;
}

export function monthlyGrantsPro(priceCents: number): boolean {
  return priceCents >= MONTHLY_MIN_CENTS;
}

// ── Billing periods ─────────────────────────────────────────────────────────────

/**
 * `d` plus `n` calendar months (UTC), clamped to the month's last day: a
 * sponsorship started on 31 January renews on 28 or 29 February.
 */
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(d.getUTCDate(), last),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
}

/** Which monthly period `now` falls in, counting from 0 at the sponsorship's start. */
export function periodIndex(startedAt: Date, now: Date): number {
  if (now <= startedAt) return 0;
  let k =
    (now.getUTCFullYear() - startedAt.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - startedAt.getUTCMonth());
  if (addMonths(startedAt, k) > now) k--;
  return Math.max(0, k);
}

/** When Pro paid by period `p` runs out: the period's end plus the grace. */
export function periodGrantEnd(startedAt: Date, p: number): Date {
  return new Date(addMonths(startedAt, p + 1).getTime() + GRACE_DAYS * DAY_MS);
}

/**
 * The `membership_grant.refId` of one period's grant: the sponsorship and the
 * period's start day, so a sponsorship resumed after a cancellation (a new
 * anchor) never collides with the periods it already had.
 */
export function periodRefId(sponsorshipId: string, startedAt: Date, p: number): string {
  return `${sponsorshipId}:${addMonths(startedAt, p).toISOString().slice(0, 10)}`;
}

/** The `membership_grant.refId` of a one-time sponsorship's grant. */
export function oneTimeRefId(sponsorshipId: string): string {
  return `${sponsorshipId}:once`;
}

// ── Webhook payload ─────────────────────────────────────────────────────────────

/** The actions this handles; GitHub documents no others for `sponsorship`. */
export const SPONSORSHIP_ACTIONS = [
  "created",
  "cancelled",
  "pending_cancellation",
  "tier_changed",
  "pending_tier_change",
  "edited",
] as const;
export type SponsorshipAction = (typeof SPONSORSHIP_ACTIONS)[number];

export interface SponsorTierLike {
  monthly_price_in_cents?: number;
  is_one_time?: boolean;
}

/** The fields of a `sponsorship` webhook this reads. */
export interface SponsorshipEventLike {
  action?: string;
  effective_date?: string | null;
  sponsorship?: {
    node_id?: string;
    created_at?: string;
    sponsor?: { id?: number | string | null } | null;
    tier?: SponsorTierLike | null;
  };
  changes?: { tier?: { from?: SponsorTierLike | null } | null } | null;
}

export function isSponsorshipAction(a: unknown): a is SponsorshipAction {
  return typeof a === "string" && (SPONSORSHIP_ACTIONS as readonly string[]).includes(a);
}

// ── Signature ───────────────────────────────────────────────────────────────────

/**
 * Verify `X-Hub-Signature-256: sha256=<hex>` — HMAC-SHA256 of the raw body
 * with the webhook secret — in constant time.
 */
export async function verifyGithubSignature(
  body: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const got = header.slice("sha256=".length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(got)) return false;
  return timingSafeEqual(got, await hmacSha256Hex(secret, body));
}
