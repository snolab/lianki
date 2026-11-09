/**
 * AI replies paid from the credit wallet (docs/partner-ai.md, "Credits").
 * Reserve first, settle after — the owner's rule (2026-11-05): "扣 first and
 * return when fail".
 *
 * 1. `reserveAi`: before the model is called, the worst case of this reply is
 *    debited in whole credits — an 'ai' ledger row and the balance change in
 *    one batch with a `credit_ai_charge` row (pending). The balance's
 *    CHECK (balance >= 0) is the guard, so two concurrent replies cannot both
 *    spend the same credits: the second one's batch fails and it is never sent
 *    to the model. The key (`<userId>:<message id>`) makes a retry a no-op.
 * 2. `settleAi`: after the call, the real cost (millionths of a credit) is
 *    added to the user's carry, whole credits are kept from the reservation as
 *    the carry crosses them, and the rest comes back as a 'refund' row with the
 *    same refId — all once, guarded by the charge row's pending → settled.
 * 3. `sweepStaleAi`: a reservation still pending long after any call can have
 *    ended (a crash between 1 and 2) is settled at no cost: refunded in full.
 *
 * The balance never goes below zero: what is kept is at most what was
 * reserved (the carry is under one credit, and the cost at most the worst case).
 */
import type { D1StmtLike } from "@/lib/d1/types";
import { CREDITS_PER_USD } from "./credits";
import { creditStmts, getBalance, type D1WithBatch } from "./credits-store";

const MICRO = 1_000_000;

/** Millionths of a credit for a USD cost, rounded up (never under-charges). */
export const usdToMicroCredits = (usd: number) =>
  Math.max(0, Math.ceil(usd * CREDITS_PER_USD * MICRO - 1e-6));

/** Whole credits to reserve for a worst case in USD: at least one. */
export const reserveCredits = (usd: number) =>
  Math.max(1, Math.ceil(usdToMicroCredits(usd) / MICRO));

/** The ledger refId of a reply's reservation and of its refund. */
export const aiRefId = (key: string) => `ai:${key}`;

export type ReserveResult =
  | { status: "reserved"; reserved: number; balance: number }
  | { status: "duplicate" }
  | { status: "insufficient"; balance: number }
  | { status: "no user" };

const isUnique = (e: unknown) => /UNIQUE|PRIMARY KEY/i.test(String(e));
const isCheck = (e: unknown) => /CHECK constraint/i.test(String(e));

export async function reserveAi(
  d1: D1WithBatch,
  r: { userId: string; key: string; reserved: number; what?: string },
  now = new Date(),
): Promise<ReserveResult> {
  if (!Number.isInteger(r.reserved) || r.reserved <= 0) throw new Error("bad reservation");
  const user = await d1.prepare("SELECT id FROM user WHERE id = ?").bind(r.userId).first();
  if (!user) return { status: "no user" };
  const at = now.toISOString();
  try {
    await d1.batch([
      d1
        .prepare(
          "INSERT INTO credit_ai_charge (key, userId, reserved, status, createdAt) VALUES (?, ?, ?, 'pending', ?)",
        )
        .bind(r.key, r.userId, r.reserved, at),
      ...creditStmts(
        d1,
        {
          userId: r.userId,
          amount: -r.reserved,
          reason: "ai",
          refId: aiRefId(r.key),
          // The feature (lib/payments/prices.ts FEATURES) for the usage view; none = a partner reply.
          note: r.what,
        },
        at,
      ),
    ]);
  } catch (err) {
    if (isUnique(err)) return { status: "duplicate" };
    if (isCheck(err)) return { status: "insufficient", balance: await getBalance(d1, r.userId) };
    throw err;
  }
  return { status: "reserved", reserved: r.reserved, balance: await getBalance(d1, r.userId) };
}

export type SettleResult = { charged: number; refunded: number } | null;

/**
 * Settle a reservation with the real cost in millionths of a credit (0 when
 * nothing was billed). Once only: null when it was not pending (already
 * settled, or never reserved).
 */
export async function settleAi(
  d1: D1WithBatch,
  key: string,
  costMicro: number,
  now = new Date(),
): Promise<SettleResult> {
  const cost = Math.max(0, Math.ceil(costMicro));
  const row = await d1
    .prepare("SELECT userId FROM credit_ai_charge WHERE key = ? AND status = 'pending'")
    .bind(key)
    .first<{ userId: string }>();
  if (!row) return null;
  const { userId } = row;
  const at = now.toISOString();
  const tok = crypto.randomUUID();
  const refundId = crypto.randomUUID();
  const mine = "EXISTS (SELECT 1 FROM credit_ai_charge WHERE key = ? AND settleId = ?)";
  const stmts: D1StmtLike[] = [
    // The guard: one settle (or sweep) wins this row; every later statement checks it.
    d1
      .prepare(
        "UPDATE credit_ai_charge SET status = 'settled', costMicro = ?, settleId = ?, settledAt = ? WHERE key = ? AND status = 'pending'",
      )
      .bind(cost, tok, at, key),
    d1
      .prepare(
        "INSERT INTO credit_ai_carry (userId, micro) VALUES (?, 0) ON CONFLICT(userId) DO NOTHING",
      )
      .bind(userId),
    d1
      .prepare(`UPDATE credit_ai_carry SET micro = micro + ? WHERE userId = ? AND ${mine}`)
      .bind(cost, userId, key, tok),
    // Whole credits the carry now holds, never more than was reserved.
    d1
      .prepare(
        `UPDATE credit_ai_charge SET charged = MIN(reserved, (SELECT micro / ${MICRO} FROM credit_ai_carry WHERE userId = ?)) WHERE key = ? AND settleId = ?`,
      )
      .bind(userId, key, tok),
    d1
      .prepare(
        `UPDATE credit_ai_carry SET micro = micro - ${MICRO} * (SELECT charged FROM credit_ai_charge WHERE key = ? AND settleId = ?) WHERE userId = ? AND ${mine}`,
      )
      .bind(key, tok, userId, key, tok),
    // What was not used comes back: the reservation's refId, reason 'refund'.
    d1
      .prepare(
        "INSERT INTO credit_ledger (id, userId, amount, reason, refId, passId, note, createdAt) SELECT ?, userId, reserved - charged, 'refund', ?, NULL, NULL, ? FROM credit_ai_charge WHERE key = ? AND settleId = ? AND reserved - charged > 0",
      )
      .bind(refundId, aiRefId(key), at, key, tok),
    d1
      .prepare(
        "UPDATE credit_balance SET balance = balance + (SELECT amount FROM credit_ledger WHERE id = ?1), updatedAt = ?2 WHERE userId = ?3 AND EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?1)",
      )
      .bind(refundId, at, userId),
  ];
  try {
    await d1.batch(stmts);
  } catch (err) {
    // A refund row already there (UNIQUE): settled elsewhere.
    if (isUnique(err)) return null;
    throw err;
  }
  const done = await d1
    .prepare("SELECT reserved, charged FROM credit_ai_charge WHERE key = ? AND settleId = ?")
    .bind(key, tok)
    .first<{ reserved: number; charged: number }>();
  if (!done) return null;
  return { charged: Number(done.charged), refunded: Number(done.reserved) - Number(done.charged) };
}

/**
 * Reservations still pending `staleMs` after they were taken: no call lasts
 * that long, so the reply that took them crashed before settling. Each is
 * settled at no cost (what Workers AI billed is unknown: refund it all).
 */
/** Credits held right now by calls still in progress (shown as "in progress"; not spendable). */
export async function pendingHolds(d1: D1WithBatch, userId: string): Promise<number> {
  const row = await d1
    .prepare(
      "SELECT COALESCE(SUM(reserved), 0) AS n FROM credit_ai_charge WHERE userId = ? AND status = 'pending'",
    )
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function sweepStaleAi(
  d1: D1WithBatch,
  staleMs: number,
  now = new Date(),
  limit = 20,
  /** Only this wallet's holds (a read of that wallet releases its own expired holds). */
  userId?: string,
): Promise<number> {
  const before = new Date(now.getTime() - staleMs).toISOString();
  const { results } = await (
    userId
      ? d1
          .prepare(
            "SELECT key FROM credit_ai_charge WHERE status = 'pending' AND createdAt < ? AND userId = ? ORDER BY createdAt LIMIT ?",
          )
          .bind(before, userId, limit)
      : d1
          .prepare(
            "SELECT key FROM credit_ai_charge WHERE status = 'pending' AND createdAt < ? ORDER BY createdAt LIMIT ?",
          )
          .bind(before, limit)
  ).all<{ key: string }>();
  let n = 0;
  for (const r of results) if (await settleAi(d1, r.key, 0, now)) n++;
  return n;
}
