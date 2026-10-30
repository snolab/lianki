/**
 * GitHub Sponsors over D1: record each sponsorship, find its Lianki user, and
 * grant Pro once per paid period. Every grant is a `membership_grant` row with
 * reason 'github-sponsors' and a refId of `<node_id>:<period start day>` (or
 * `<node_id>:once`), whose UNIQUE (reason, refId) makes a redelivered webhook
 * — or the same period settled from two places — a no-op. Nothing runs on a
 * timer.
 */
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import { extendedProEnd } from "./passes";
import {
  SPONSOR_GRANT_REASON,
  addMonths,
  isSponsorshipAction,
  monthlyGrantsPro,
  oneTimeDays,
  oneTimeRefId,
  periodGrantEnd,
  periodIndex,
  periodRefId,
  verifyGithubSignature,
  type SponsorTierLike,
  type SponsorshipEventLike,
} from "./sponsors";

export type D1WithBatch = D1Like & { batch(stmts: D1StmtLike[]): Promise<unknown> };

export interface SponsorshipRow {
  id: string;
  githubId: string;
  userId: string | null;
  oneTime: number;
  priceCents: number;
  startedAt: string;
  status: "active" | "cancelled";
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const isUnique = (e: unknown) => /UNIQUE|PRIMARY KEY/i.test(String(e));

/** The Lianki user who has signed in with (or linked) this GitHub id, if any. */
export async function userForGithubId(d1: D1Like, githubId: string): Promise<string | null> {
  const row = await d1
    .prepare("SELECT userId FROM account WHERE providerId = 'github' AND accountId = ? LIMIT 1")
    .bind(githubId)
    .first<{ userId: string }>();
  return row?.userId ?? null;
}

// ── Grants ──────────────────────────────────────────────────────────────────────

/**
 * Insert the grant row and move `proEndsAt` to `end` in one batch. Returns
 * false when this refId was granted before. `end` never shortens Pro: the
 * days recorded are those actually added, 0 when Pro already ran past it.
 */
async function grant(
  d1: D1WithBatch,
  userId: string,
  refId: string,
  end: (current: Date | undefined) => Date,
  now: Date,
): Promise<boolean> {
  // Settled on every status read, so look before writing: most calls are repeats.
  const seen = await d1
    .prepare("SELECT id FROM membership_grant WHERE reason = ? AND refId = ?")
    .bind(SPONSOR_GRANT_REASON, refId)
    .first();
  if (seen) return false;
  const user = await d1
    .prepare("SELECT proEndsAt FROM user WHERE id = ?")
    .bind(userId)
    .first<{ proEndsAt: string | null }>();
  if (!user) return false;
  const current = user.proEndsAt ? new Date(user.proEndsAt) : undefined;
  const next = end(current);
  const from = current && current > now ? current : now;
  const days = Math.max(0, Math.round((next.getTime() - from.getTime()) / 86_400_000));
  const at = now.toISOString();
  const stmts: D1StmtLike[] = [
    d1
      .prepare(
        "INSERT INTO membership_grant (id, userId, kind, days, reason, refId, createdAt) VALUES (?, ?, 'pro', ?, ?, ?, ?)",
      )
      .bind(crypto.randomUUID(), userId, days, SPONSOR_GRANT_REASON, refId, at),
  ];
  if (!current || next > current) {
    stmts.push(
      d1
        .prepare("UPDATE user SET proEndsAt = ?, updatedAt = ? WHERE id = ?")
        .bind(next.toISOString(), at, userId),
    );
  }
  try {
    await d1.batch(stmts);
    return true;
  } catch (e) {
    if (isUnique(e)) return false;
    throw e;
  }
}

/**
 * Grant what a claimed sponsorship is owed now: a one-time tier's days once,
 * or Pro through the current monthly period plus the grace, once per period.
 * A cancelled sponsorship, a period starting at or after a scheduled
 * cancellation, and a monthly tier under the threshold earn nothing more —
 * nothing already granted is taken back.
 */
export async function settleSponsorship(
  d1: D1WithBatch,
  s: SponsorshipRow,
  now = new Date(),
): Promise<boolean> {
  if (!s.userId || s.status === "cancelled") return false;
  if (s.oneTime) {
    const days = oneTimeDays(s.priceCents);
    if (days <= 0) return false;
    return grant(d1, s.userId, oneTimeRefId(s.id), (c) => extendedProEnd(c, days, now), now);
  }
  if (!monthlyGrantsPro(s.priceCents)) return false;
  const started = new Date(s.startedAt);
  const p = periodIndex(started, now);
  if (s.endsAt && addMonths(started, p) >= new Date(s.endsAt)) return false;
  const end = periodGrantEnd(started, p);
  return grant(d1, s.userId, periodRefId(s.id, started, p), (c) => (c && c > end ? c : end), now);
}

/**
 * Claim sponsorships waiting for this user's GitHub id, then settle all of
 * theirs. Called after a GitHub account is created or linked, and whenever the
 * user reads their membership status (which also carries monthly sponsorships
 * into each new period, since GitHub sends no renewal event).
 */
export async function settleUserSponsorships(
  d1: D1WithBatch,
  userId: string,
  now = new Date(),
): Promise<number> {
  const at = now.toISOString();
  const ids = (
    await d1
      .prepare("SELECT accountId FROM account WHERE userId = ? AND providerId = 'github'")
      .bind(userId)
      .all<{ accountId: string }>()
  ).results;
  for (const { accountId } of ids) {
    await d1
      .prepare(
        "UPDATE github_sponsorship SET userId = ?, updatedAt = ? WHERE githubId = ? AND userId IS NULL",
      )
      .bind(userId, at, String(accountId))
      .run();
  }
  const rows = (
    await d1
      .prepare("SELECT * FROM github_sponsorship WHERE userId = ? AND status = 'active'")
      .bind(userId)
      .all<SponsorshipRow>()
  ).results;
  let granted = 0;
  for (const r of rows) if (await settleSponsorship(d1, r, now)) granted++;
  return granted;
}

// ── Webhook events ──────────────────────────────────────────────────────────────

export type SponsorEventResult =
  | { status: "granted" | "recorded"; sponsorshipId: string }
  | { status: "pending"; sponsorshipId: string }
  | { status: "ignored"; reason: string };

const price = (t: SponsorTierLike | null | undefined) =>
  typeof t?.monthly_price_in_cents === "number" ? t.monthly_price_in_cents : null;

/**
 * Apply one `sponsorship` webhook: upsert the sponsorship, attach it to a
 * Lianki user when the GitHub id is known (otherwise it waits to be claimed),
 * and settle what it is owed. Idempotent: a redelivery changes nothing.
 */
export async function applySponsorshipEvent(
  d1: D1WithBatch,
  event: SponsorshipEventLike,
  now = new Date(),
): Promise<SponsorEventResult> {
  const action = event.action;
  if (!isSponsorshipAction(action)) return { status: "ignored", reason: "unknown action" };
  const sp = event.sponsorship;
  const id = sp?.node_id;
  const githubId = sp?.sponsor?.id;
  const startedAt = sp?.created_at;
  if (!id || githubId == null || !startedAt || Number.isNaN(Date.parse(startedAt)))
    return { status: "ignored", reason: "malformed" };

  const at = now.toISOString();
  const prev = await d1
    .prepare("SELECT * FROM github_sponsorship WHERE id = ?")
    .bind(id)
    .first<SponsorshipRow>();

  // A pending tier change has not happened yet: keep the price in effect.
  const tierNow =
    action === "pending_tier_change" ? (event.changes?.tier?.from ?? sp?.tier) : sp?.tier;
  const row: SponsorshipRow = prev
    ? { ...prev }
    : {
        id,
        githubId: String(githubId),
        userId: null,
        oneTime: sp?.tier?.is_one_time ? 1 : 0,
        priceCents: price(tierNow) ?? 0,
        startedAt: new Date(startedAt).toISOString(),
        status: "active",
        endsAt: null,
        createdAt: at,
        updatedAt: at,
      };
  row.updatedAt = at;

  switch (action) {
    case "created": {
      // A redelivered `created` must not revive a sponsorship cancelled since;
      // one resumed later carries a later created_at.
      const restarted = prev && new Date(startedAt) > new Date(prev.startedAt);
      if (!prev || restarted) {
        row.status = "active";
        row.endsAt = null;
        row.startedAt = new Date(startedAt).toISOString();
        row.oneTime = sp?.tier?.is_one_time ? 1 : 0;
        row.priceCents = price(sp?.tier) ?? row.priceCents;
      }
      break;
    }
    case "tier_changed":
    case "edited":
      row.priceCents = price(sp?.tier) ?? row.priceCents;
      if (typeof sp?.tier?.is_one_time === "boolean") row.oneTime = sp.tier.is_one_time ? 1 : 0;
      break;
    case "pending_tier_change":
      break;
    case "pending_cancellation":
      if (event.effective_date && !Number.isNaN(Date.parse(event.effective_date)))
        row.endsAt = new Date(event.effective_date).toISOString();
      break;
    case "cancelled":
      row.status = "cancelled";
      row.endsAt = row.endsAt && new Date(row.endsAt) < now ? row.endsAt : at;
      break;
  }

  if (!row.userId) row.userId = await userForGithubId(d1, row.githubId);

  await d1
    .prepare(
      `INSERT INTO github_sponsorship (id, githubId, userId, oneTime, priceCents, startedAt, status, endsAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET userId = excluded.userId, oneTime = excluded.oneTime,
         priceCents = excluded.priceCents, startedAt = excluded.startedAt, status = excluded.status,
         endsAt = excluded.endsAt, updatedAt = excluded.updatedAt`,
    )
    .bind(
      row.id,
      row.githubId,
      row.userId,
      row.oneTime,
      row.priceCents,
      row.startedAt,
      row.status,
      row.endsAt,
      row.createdAt,
      row.updatedAt,
    )
    .run();

  if (!row.userId) return { status: "pending", sponsorshipId: id };
  const granted = await settleSponsorship(d1, row, now);
  return { status: granted ? "granted" : "recorded", sponsorshipId: id };
}

// ── The endpoint ────────────────────────────────────────────────────────────────

export interface WebhookRequestLike {
  body: string;
  event: string | null;
  signature: string | null;
}

/**
 * The webhook's whole decision, minus the wiring: 503 without a secret, 401
 * on a bad signature, 200 to `ping` and to events it does not handle. A throw
 * is a 500, which GitHub shows as a failed delivery to redeliver.
 */
export async function handleSponsorsWebhook(
  req: WebhookRequestLike,
  secret: string | undefined,
  d1: () => D1WithBatch,
  now = new Date(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!secret) return { status: 503, body: { error: "GitHub Sponsors is not enabled" } };
  if (!(await verifyGithubSignature(req.body, req.signature, secret)))
    return { status: 401, body: { error: "Bad signature" } };
  if (req.event === "ping") return { status: 200, body: { pong: true } };
  if (req.event !== "sponsorship") return { status: 200, body: { received: true, ignored: true } };
  let event: SponsorshipEventLike;
  try {
    event = JSON.parse(req.body) as SponsorshipEventLike;
  } catch {
    return { status: 400, body: { error: "Bad JSON" } };
  }
  const result = await applySponsorshipEvent(d1(), event, now);
  return { status: 200, body: { received: true, ...result } };
}
