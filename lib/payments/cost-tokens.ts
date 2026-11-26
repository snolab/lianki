/**
 * Learning Partner tokens for /dev/costs (docs/payments.md, "Cost ledger",
 * "Learning Partner tokens"; owner, 2026-11-27): prompt tokens, the part of
 * them Workers AI served from its prefix cache, and completion tokens, per day
 * (or hour) and per account, with the cache hit rate = cached ÷ prompt.
 *
 * - The counts are on settled `credit_ai_charge` rows (settleAi, written by
 *   lib/partner-ai.ts); a row without them (settled before migration 0086, or
 *   not a Learning Partner reply) is left out.
 * - Buckets are in the viewer's zone at offset `offMin` (0 = UTC), as the rest
 *   of /dev/costs; `zone` labels it ("UTC", "UTC+9"). Every bucket of the
 *   window is listed, empty ones too.
 * - Aggregated counts only: the account id and display name, never an email
 *   or any text. The aggregation (`tokenSeries`, `hitRate`) is pure and
 *   unit-tested.
 */
import type { D1Like } from "@/lib/d1/types";
import { offsetLabel } from "@/lib/time-zone";
import { dayBuckets, type HourWindow } from "./cost-buckets";
import { rangeBounds, sqlDay, sqlHour, type CostRange } from "./cost-ledger";

export type TokenTotals = {
  /** Prompt tokens, cached ones included. */
  tokensIn: number;
  /** Prompt tokens served from the prefix cache (never more than tokensIn). */
  cachedIn: number;
  tokensOut: number;
  replies: number;
  /** cachedIn ÷ tokensIn, 0–1; null when there was no prompt token to hit. */
  hitRate: number | null;
};

/** One grouped row from D1: bucket (or account), sums and the reply count. */
export type TokenGroup = {
  b: string;
  tin: number | null;
  cin: number | null;
  tout: number | null;
  n: number;
};

/** The cache hit rate: cached ÷ prompt tokens, clamped to 0–1; null with no prompt tokens. */
export function hitRate(tokensIn: number, cachedIn: number): number | null {
  if (!(tokensIn > 0)) return null;
  return Math.min(1, Math.max(0, cachedIn) / tokensIn);
}

const zero = (): Omit<TokenTotals, "hitRate"> => ({
  tokensIn: 0,
  cachedIn: 0,
  tokensOut: 0,
  replies: 0,
});
const nn = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? v : 0);
const done = (t: Omit<TokenTotals, "hitRate">): TokenTotals => ({
  ...t,
  hitRate: hitRate(t.tokensIn, t.cachedIn),
});

export type TokenSeries = {
  rows: ({ bucket: string } & TokenTotals)[];
  totals: TokenTotals;
};

/**
 * Buckets × token sums. Groups outside `buckets` are dropped (the window
 * decides); empty buckets stay as zero rows with a null hit rate.
 */
export function tokenSeries(buckets: string[], groups: TokenGroup[]): TokenSeries {
  const by = new Map(buckets.map((b) => [b, zero()]));
  const totals = zero();
  for (const g of groups) {
    const row = by.get(g.b);
    if (!row) continue;
    for (const t of [row, totals]) {
      t.tokensIn += nn(g.tin);
      t.cachedIn += Math.min(nn(g.cin), nn(g.tin));
      t.tokensOut += nn(g.tout);
      t.replies += g.n;
    }
  }
  return {
    rows: buckets.map((bucket) => ({ bucket, ...done(by.get(bucket)!) })),
    totals: done(totals),
  };
}

export type TokenUser = { userId: string; name: string | null } & TokenTotals;

/** Accounts from grouped rows, the most tokens (prompt + completion) first. */
export function tokenUsers(rows: (TokenGroup & { name: string | null })[]): TokenUser[] {
  return rows
    .map((r) => ({
      userId: r.b,
      name: r.name ?? null,
      ...done({
        tokensIn: nn(r.tin),
        cachedIn: Math.min(nn(r.cin), nn(r.tin)),
        tokensOut: nn(r.tout),
        replies: r.n,
      }),
    }))
    .sort(
      (a, b) =>
        b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut) || a.userId.localeCompare(b.userId),
    );
}

const SETTLED = "status = 'settled' AND tokensIn IS NOT NULL AND settledAt >= ? AND settledAt < ?";
const SUMS = "SUM(tokensIn) AS tin, SUM(cachedIn) AS cin, SUM(tokensOut) AS tout, COUNT(*) AS n";

export type PartnerTokens = {
  range: CostRange;
  /** The zone the buckets are in: "UTC", "UTC+9"… */
  zone: string;
  bucket: "day" | "hour";
} & TokenSeries & { users: TokenUser[] };

/**
 * Learning Partner tokens over `range` (days at `offMin`), by day — or, with
 * a `HourWindow`, by hour of that window — and by account (every account with
 * a reply in the window, the most tokens first; no paging).
 */
export async function partnerTokens(
  d1: D1Like,
  range: CostRange,
  offMin = 0,
  hours?: HourWindow,
): Promise<PartnerTokens> {
  const b = hours ?? rangeBounds(range, offMin);
  const bucketSql = hours ? sqlHour("settledAt", hours.offMin) : sqlDay("settledAt", offMin);
  const [series, users] = await Promise.all([
    d1
      .prepare(
        `SELECT ${bucketSql} AS b, ${SUMS} FROM credit_ai_charge WHERE ${SETTLED} GROUP BY b`,
      )
      .bind(b.startIso, b.endIso)
      .all<TokenGroup>(),
    d1
      .prepare(
        `SELECT c.userId AS b, us.name AS name, SUM(c.tokensIn) AS tin, SUM(c.cachedIn) AS cin, SUM(c.tokensOut) AS tout, COUNT(*) AS n FROM credit_ai_charge c LEFT JOIN user us ON us.id = c.userId WHERE c.status = 'settled' AND c.tokensIn IS NOT NULL AND c.settledAt >= ? AND c.settledAt < ? GROUP BY c.userId`,
      )
      .bind(b.startIso, b.endIso)
      .all<TokenGroup & { name: string | null }>(),
  ]);
  return {
    range,
    zone: offsetLabel(offMin),
    bucket: hours ? "hour" : "day",
    ...tokenSeries(hours ? hours.hours : dayBuckets(range), series.results),
    users: tokenUsers(users.results),
  };
}
