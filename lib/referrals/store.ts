/**
 * Invites and gift codes over D1. Nothing here runs on a timer: activation is
 * checked when the invitee or the inviter next asks for their status, and the
 * purchase bonus when the invitee's payment is fulfilled. Every reward is a
 * `membership_grant` row whose UNIQUE (reason, refId) makes it once-only, so a
 * check may run any number of times.
 */
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import { extendedProEnd } from "@/lib/payments/passes";
import {
  ACTIVATION_REVIEW_DAYS,
  CLAIM_MAX_ACCOUNT_AGE_H,
  DAY_MS,
  INVITEE_TRIAL_DAYS,
  INVITER_ACTIVATED_DAYS,
  INVITER_PURCHASE_DAYS,
  activationWindow,
  cappedDays,
  maskEmail,
  newCode,
} from "./rules";

export type D1WithBatch = D1Like & { batch(stmts: D1StmtLike[]): Promise<unknown> };

const TRIAL_DAYS = 90; // lib/membership.ts — the trial a new account starts with

type UserRow = {
  id: string;
  email: string;
  createdAt: string;
  trialEndsAt: string | null;
  proEndsAt: string | null;
};

type ReferralRow = {
  inviteeId: string;
  inviterId: string;
  code: string;
  createdAt: string;
  activatedAt: string | null;
  purchasedAt: string | null;
};

const isUnique = (e: unknown) => /UNIQUE|PRIMARY KEY/i.test(String(e));

async function getUser(d1: D1Like, id: string): Promise<UserRow | null> {
  return d1
    .prepare("SELECT id, email, createdAt, trialEndsAt, proEndsAt FROM user WHERE id = ?")
    .bind(id)
    .first<UserRow>();
}

// ── Grants ──────────────────────────────────────────────────────────────────────

function grantRow(
  d1: D1Like,
  g: { userId: string; kind: "trial" | "pro"; days: number; reason: string; refId: string },
  at: string,
): D1StmtLike {
  return d1
    .prepare(
      "INSERT INTO membership_grant (id, userId, kind, days, reason, refId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), g.userId, g.kind, g.days, g.reason, g.refId, at);
}

/**
 * Give `days` of Pro (stacking on running Pro) and record why, in one batch.
 * Extra statements ride in the same batch. Returns false when this reason+ref
 * was already granted.
 */
async function grantPro(
  d1: D1WithBatch,
  userId: string,
  days: number,
  reason: string,
  refId: string,
  now: Date,
  extra: D1StmtLike[] = [],
): Promise<boolean> {
  const user = await getUser(d1, userId);
  if (!user) return false;
  const at = now.toISOString();
  const stmts = [grantRow(d1, { userId, kind: "pro", days, reason, refId }, at), ...extra];
  if (days > 0) {
    const end = extendedProEnd(user.proEndsAt ? new Date(user.proEndsAt) : undefined, days, now);
    stmts.push(
      d1
        .prepare("UPDATE user SET proEndsAt = ?, updatedAt = ? WHERE id = ?")
        .bind(end.toISOString(), at, userId),
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

/** Pro days invites have earned this user in the 365 days before `now`. */
export async function earnedLastYear(d1: D1Like, userId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 365 * DAY_MS).toISOString();
  const row = await d1
    .prepare(
      "SELECT COALESCE(SUM(days), 0) AS n FROM membership_grant WHERE userId = ? AND reason IN ('referral-activated', 'referral-purchase') AND createdAt > ?",
    )
    .bind(userId, since)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// ── Invite codes ────────────────────────────────────────────────────────────────

export async function getOrCreateInviteCode(
  d1: D1Like,
  userId: string,
  now = new Date(),
): Promise<string> {
  const select = d1.prepare("SELECT code FROM invite_code WHERE userId = ?").bind(userId);
  const existing = await select.first<{ code: string }>();
  if (existing) return existing.code;
  for (let i = 0; i < 5; i++) {
    try {
      await d1
        .prepare("INSERT INTO invite_code (code, userId, createdAt) VALUES (?, ?, ?)")
        .bind(newCode(), userId, now.toISOString())
        .run();
      break;
    } catch (e) {
      if (!isUnique(e)) throw e;
      // Either a code collision (try another) or a concurrent request made ours.
      const made = await select.first<{ code: string }>();
      if (made) return made.code;
    }
  }
  const made = await select.first<{ code: string }>();
  if (!made) throw new Error("could not create an invite code");
  return made.code;
}

export async function inviterForCode(d1: D1Like, code: string): Promise<string | null> {
  const row = await d1
    .prepare("SELECT userId FROM invite_code WHERE code = ?")
    .bind(code)
    .first<{ userId: string }>();
  return row?.userId ?? null;
}

export type ClaimResult =
  | { status: "claimed"; trialEndsAt: Date }
  | {
      status: "rejected";
      reason: "unknown code" | "self" | "not new" | "already invited" | "no user";
    };

/**
 * Record that `inviteeId` came through `code`, and extend their trial. Only a
 * fresh account can be invited, so existing users cannot farm each other.
 */
export async function claimInvite(
  d1: D1WithBatch,
  inviteeId: string,
  code: string,
  now = new Date(),
): Promise<ClaimResult> {
  const inviterId = await inviterForCode(d1, code);
  if (!inviterId) return { status: "rejected", reason: "unknown code" };
  if (inviterId === inviteeId) return { status: "rejected", reason: "self" };
  const invitee = await getUser(d1, inviteeId);
  if (!invitee) return { status: "rejected", reason: "no user" };
  const age = now.getTime() - new Date(invitee.createdAt).getTime();
  if (!(age <= CLAIM_MAX_ACCOUNT_AGE_H * 60 * 60 * 1000))
    return { status: "rejected", reason: "not new" };

  // The trial is granted lazily on first status read; start from it if it exists.
  const createdAt = new Date(invitee.createdAt);
  const trialBase = invitee.trialEndsAt
    ? new Date(invitee.trialEndsAt)
    : new Date(createdAt.getTime() + TRIAL_DAYS * DAY_MS);
  const trialEndsAt = new Date(trialBase.getTime() + INVITEE_TRIAL_DAYS * DAY_MS);
  const at = now.toISOString();
  try {
    await d1.batch([
      d1
        .prepare("INSERT INTO referral (inviteeId, inviterId, code, createdAt) VALUES (?, ?, ?, ?)")
        .bind(inviteeId, inviterId, code, at),
      grantRow(
        d1,
        {
          userId: inviteeId,
          kind: "trial",
          days: INVITEE_TRIAL_DAYS,
          reason: "invitee",
          refId: inviteeId,
        },
        at,
      ),
      d1
        .prepare("UPDATE user SET trialEndsAt = ?, updatedAt = ? WHERE id = ?")
        .bind(trialEndsAt.toISOString(), at, inviteeId),
    ]);
  } catch (e) {
    if (isUnique(e)) return { status: "rejected", reason: "already invited" };
    throw e;
  }
  return { status: "claimed", trialEndsAt };
}

// ── Activation ──────────────────────────────────────────────────────────────────

/** Distinct UTC days on which `email` reviewed anything — page cards or words — in [from, to]. */
export async function reviewDays(d1: D1Like, email: string, from: Date, to: Date): Promise<number> {
  const f = from.toISOString();
  const t = to.toISOString();
  const row = await d1
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT substr(json_extract(j.value, '$.review'), 1, 10) AS d
           FROM fsrs_notes n, json_each(n.log) j
          WHERE n.email = ? AND json_extract(j.value, '$.review') BETWEEN ? AND ?
         UNION
         SELECT substr(reviewed_at, 1, 10) FROM word_reviews
          WHERE email = ? AND reviewed_at BETWEEN ? AND ?
       )`,
    )
    .bind(email, f, t, email, f, t)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * Settle a pending referral if the invitee is now active: the inviter gets
 * their (capped) days and the referral is stamped. Safe to call repeatedly.
 */
export async function settleActivation(
  d1: D1WithBatch,
  r: ReferralRow,
  now = new Date(),
): Promise<boolean> {
  if (r.activatedAt) return false;
  const invitee = await getUser(d1, r.inviteeId);
  if (!invitee) return false;
  const { from, to } = activationWindow(new Date(r.createdAt));
  const days = await reviewDays(d1, invitee.email, from, to < now ? to : now);
  if (days < ACTIVATION_REVIEW_DAYS) return false;
  const give = cappedDays(INVITER_ACTIVATED_DAYS, await earnedLastYear(d1, r.inviterId, now));
  return grantPro(d1, r.inviterId, give, "referral-activated", r.inviteeId, now, [
    d1
      .prepare("UPDATE referral SET activatedAt = ? WHERE inviteeId = ?")
      .bind(now.toISOString(), r.inviteeId),
  ]);
}

/** Check the referral that brought this user in, if it is still pending. */
export async function settleAsInvitee(d1: D1WithBatch, userId: string, now = new Date()) {
  const r = await d1
    .prepare("SELECT * FROM referral WHERE inviteeId = ? AND activatedAt IS NULL")
    .bind(userId)
    .first<ReferralRow>();
  if (r) await settleActivation(d1, r, now);
}

/** First pass bought by an invitee: the inviter's purchase bonus, once. */
export async function rewardPurchase(d1: D1WithBatch, buyerId: string, now = new Date()) {
  const r = await d1
    .prepare("SELECT * FROM referral WHERE inviteeId = ? AND purchasedAt IS NULL")
    .bind(buyerId)
    .first<ReferralRow>();
  if (!r) return false;
  const give = cappedDays(INVITER_PURCHASE_DAYS, await earnedLastYear(d1, r.inviterId, now));
  return grantPro(d1, r.inviterId, give, "referral-purchase", buyerId, now, [
    d1
      .prepare("UPDATE referral SET purchasedAt = ? WHERE inviteeId = ?")
      .bind(now.toISOString(), buyerId),
  ]);
}

export interface InviteSummary {
  code: string;
  invited: number;
  activated: number;
  earnedLastYear: number;
  friends: { email: string; invitedAt: string; activated: boolean; purchased: boolean }[];
}

/** The inviter's view; settles any pending activations first. */
export async function inviteSummary(
  d1: D1WithBatch,
  userId: string,
  now = new Date(),
): Promise<InviteSummary> {
  const code = await getOrCreateInviteCode(d1, userId, now);
  const list = async () =>
    (
      await d1
        .prepare(
          "SELECT r.*, u.email FROM referral r JOIN user u ON u.id = r.inviteeId WHERE r.inviterId = ? ORDER BY r.createdAt DESC",
        )
        .bind(userId)
        .all<ReferralRow & { email: string }>()
    ).results;
  let rows = await list();
  let changed = false;
  for (const r of rows) if (!r.activatedAt && (await settleActivation(d1, r, now))) changed = true;
  if (changed) rows = await list();
  return {
    code,
    invited: rows.length,
    activated: rows.filter((r) => r.activatedAt).length,
    earnedLastYear: await earnedLastYear(d1, userId, now),
    friends: rows.map((r) => ({
      email: maskEmail(r.email),
      invitedAt: r.createdAt,
      activated: Boolean(r.activatedAt),
      purchased: Boolean(r.purchasedAt),
    })),
  };
}

// ── Gift codes ──────────────────────────────────────────────────────────────────

export interface GiftCodeInput {
  days: number;
  maxUses: number;
  note?: string;
  expiresAt?: Date;
}

export async function createGiftCode(
  d1: D1Like,
  createdBy: string,
  input: GiftCodeInput,
  now = new Date(),
): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = newCode(10);
    try {
      await d1
        .prepare(
          "INSERT INTO gift_code (code, days, maxUses, note, createdBy, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          code,
          input.days,
          input.maxUses,
          input.note ?? null,
          createdBy,
          now.toISOString(),
          input.expiresAt?.toISOString() ?? null,
        )
        .run();
      return code;
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }
  throw new Error("could not create a gift code");
}

export type GiftCodeRow = {
  code: string;
  days: number;
  maxUses: number;
  uses: number;
  note: string | null;
  createdAt: string;
  expiresAt: string | null;
};

export async function listGiftCodes(d1: D1Like): Promise<GiftCodeRow[]> {
  return (
    await d1
      .prepare(
        "SELECT code, days, maxUses, uses, note, createdAt, expiresAt FROM gift_code ORDER BY createdAt DESC LIMIT 200",
      )
      .all<GiftCodeRow>()
  ).results;
}

export type RedeemResult =
  | { status: "redeemed"; days: number }
  | { status: "rejected"; reason: "unknown code" | "expired" | "used up" | "already redeemed" };

export async function redeemGiftCode(
  d1: D1WithBatch,
  userId: string,
  code: string,
  now = new Date(),
): Promise<RedeemResult> {
  const gift = await d1
    .prepare("SELECT days, expiresAt FROM gift_code WHERE code = ?")
    .bind(code)
    .first<{ days: number; expiresAt: string | null }>();
  if (!gift) return { status: "rejected", reason: "unknown code" };
  if (gift.expiresAt && new Date(gift.expiresAt) <= now)
    return { status: "rejected", reason: "expired" };
  const refId = `${code}:${userId}`;
  const seen = await d1
    .prepare("SELECT id FROM membership_grant WHERE reason = 'gift' AND refId = ?")
    .bind(refId)
    .first();
  if (seen) return { status: "rejected", reason: "already redeemed" };

  // Take a use atomically; give it back if the grant turns out to be a duplicate.
  const took = await d1
    .prepare(
      "UPDATE gift_code SET uses = uses + 1 WHERE code = ? AND uses < maxUses RETURNING uses",
    )
    .bind(code)
    .first();
  if (!took) return { status: "rejected", reason: "used up" };
  if (!(await grantPro(d1, userId, gift.days, "gift", refId, now))) {
    await d1.prepare("UPDATE gift_code SET uses = uses - 1 WHERE code = ?").bind(code).run();
    return { status: "rejected", reason: "already redeemed" };
  }
  return { status: "redeemed", days: gift.days };
}
