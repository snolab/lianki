/**
 * Prepaid credits over D1. Every change is a `credit_ledger` row plus the
 * matching change to the cached `credit_balance`, in ONE batch (one D1
 * transaction), so the two never disagree:
 *
 * - UNIQUE (reason, refId) on the ledger makes each entry once-only — a
 *   redelivered webhook, a double click or a re-run refund is a no-op.
 * - CHECK (balance >= 0) on the balance makes overspending impossible: a spend
 *   larger than the balance fails the batch, and with it the Pro extension that
 *   rode along. The pre-read balance is only for a friendly answer; the CHECK
 *   is the guard, so two concurrent spends cannot both pass.
 */
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import type { CreditReason } from "./credits";
import { shortfall } from "./credits";
import { passFor, type PassId } from "./passes";

export type D1WithBatch = D1Like & { batch(stmts: D1StmtLike[]): Promise<unknown> };

export interface LedgerEntry {
  id: string;
  amount: number;
  reason: CreditReason;
  refId: string;
  passId: string | null;
  note: string | null;
  createdAt: string;
}

const isUnique = (e: unknown) => /UNIQUE|PRIMARY KEY/i.test(String(e));
const isCheck = (e: unknown) => /CHECK constraint/i.test(String(e));

export async function getBalance(d1: D1Like, userId: string): Promise<number> {
  const row = await d1
    .prepare("SELECT balance FROM credit_balance WHERE userId = ?")
    .bind(userId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

/** The newest `limit` entries, newest first. */
export async function ledger(d1: D1Like, userId: string, limit = 50): Promise<LedgerEntry[]> {
  return (
    await d1
      .prepare(
        "SELECT id, amount, reason, refId, passId, note, createdAt FROM credit_ledger WHERE userId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?",
      )
      .bind(userId, limit)
      .all<LedgerEntry>()
  ).results;
}

export interface CreditEntryInput {
  userId: string;
  /** JPY, signed: + adds to the balance, − takes from it. */
  amount: number;
  reason: CreditReason;
  refId: string;
  passId?: string;
  note?: string;
}

/** The statements of one entry: the ledger row and the balance change. */
export function creditStmts(d1: D1Like, e: CreditEntryInput, at: string): D1StmtLike[] {
  return [
    d1
      .prepare(
        "INSERT INTO credit_ledger (id, userId, amount, reason, refId, passId, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        e.userId,
        e.amount,
        e.reason,
        e.refId,
        e.passId ?? null,
        e.note ?? null,
        at,
      ),
    // Make sure the row exists (at 0), then add — not an upsert of the delta:
    // SQLite checks CHECK on the proposed INSERT row before ON CONFLICT, so a
    // negative upsert would fail even with enough balance. The UPDATE is where
    // an overdraft trips the CHECK.
    d1
      .prepare(
        "INSERT INTO credit_balance (userId, balance, updatedAt) VALUES (?, 0, ?) ON CONFLICT(userId) DO NOTHING",
      )
      .bind(e.userId, at),
    d1
      .prepare("UPDATE credit_balance SET balance = balance + ?, updatedAt = ? WHERE userId = ?")
      .bind(e.amount, at, e.userId),
  ];
}

export type ApplyResult =
  | { status: "applied"; balance: number }
  | { status: "duplicate" }
  | { status: "insufficient"; balance: number }
  | { status: "no user" };

/** Apply one entry (plus any statements that must commit with it). */
export async function applyCredit(
  d1: D1WithBatch,
  e: CreditEntryInput,
  now = new Date(),
  extra: D1StmtLike[] = [],
): Promise<ApplyResult> {
  if (!Number.isInteger(e.amount) || e.amount === 0) throw new Error("bad credit amount");
  const user = await d1.prepare("SELECT id FROM user WHERE id = ?").bind(e.userId).first();
  if (!user) return { status: "no user" };
  try {
    await d1.batch([...creditStmts(d1, e, now.toISOString()), ...extra]);
  } catch (err) {
    if (isUnique(err)) return { status: "duplicate" };
    if (isCheck(err)) return { status: "insufficient", balance: await getBalance(d1, e.userId) };
    throw err;
  }
  return { status: "applied", balance: await getBalance(d1, e.userId) };
}

// ── Top-ups ─────────────────────────────────────────────────────────────────────

/**
 * Credit a paid top-up. `provider` + `paymentId` is the idempotency key, so
 * every provider (lib/payments/providers) credits the same ledger once per
 * payment however often it redelivers.
 */
export function creditTopup(
  d1: D1WithBatch,
  t: {
    userId: string;
    amount: number;
    provider: string;
    paymentId: string;
    reason?: "topup" | "sponsor";
  },
  now = new Date(),
) {
  if (!(t.amount > 0)) throw new Error("top-up must be positive");
  return applyCredit(
    d1,
    {
      userId: t.userId,
      amount: t.amount,
      reason: t.reason ?? "topup",
      refId: `${t.provider}:${t.paymentId}`,
    },
    now,
  );
}

// ── Spending on passes ──────────────────────────────────────────────────────────

/**
 * `proEndsAt` + days, from now when Pro has lapsed — computed in SQL so two
 * concurrent extensions both count (a JS read-modify-write would lose one).
 * Same ISO format as `Date.toISOString()`, which the rest of the code writes.
 */
const EXTEND_PRO_SQL =
  "UPDATE user SET proEndsAt = strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN julianday(proEndsAt) > julianday(?1) THEN proEndsAt ELSE ?1 END, '+' || ?2 || ' days'), updatedAt = ?1 WHERE id = ?3";

/** The reverse, never ending before now. */
const SHORTEN_PRO_SQL =
  "UPDATE user SET proEndsAt = CASE WHEN julianday(proEndsAt, '-' || ?2 || ' days') > julianday(?1) THEN strftime('%Y-%m-%dT%H:%M:%fZ', proEndsAt, '-' || ?2 || ' days') ELSE ?1 END, updatedAt = ?1 WHERE id = ?3 AND proEndsAt IS NOT NULL";

export type BuyResult =
  | { status: "applied"; balance: number; proEndsAt: string }
  | { status: "duplicate"; balance: number; proEndsAt: string | null }
  | { status: "insufficient"; balance: number; price: number; missing: number }
  | { status: "rejected"; reason: "unknown pass" | "no user" };

async function proEnd(d1: D1Like, userId: string): Promise<string | null> {
  const row = await d1
    .prepare("SELECT proEndsAt FROM user WHERE id = ?")
    .bind(userId)
    .first<{ proEndsAt: string | null }>();
  return row?.proEndsAt ?? null;
}

/**
 * Buy a pass with the balance: debit, ledger row and Pro extension in one
 * batch. `key` is the client's idempotency key (one per click), so a retried
 * request buys once.
 */
export async function buyPassWithCredits(
  d1: D1WithBatch,
  userId: string,
  passId: unknown,
  key: string,
  now = new Date(),
): Promise<BuyResult> {
  const pass = passFor(passId);
  if (!pass) return { status: "rejected", reason: "unknown pass" };
  const balance = await getBalance(d1, userId);
  const insufficient = (b: number): BuyResult => ({
    status: "insufficient",
    balance: b,
    price: pass.amount,
    missing: shortfall(b, pass.amount),
  });
  if (balance < pass.amount) {
    // A retry of a spend that already went through is not "insufficient".
    const done = await d1
      .prepare("SELECT id FROM credit_ledger WHERE reason = 'pass' AND refId = ?")
      .bind(`${userId}:${key}`)
      .first();
    if (!done) return insufficient(balance);
  }
  const at = now.toISOString();
  const r = await applyCredit(
    d1,
    {
      userId,
      amount: -pass.amount,
      reason: "pass",
      refId: `${userId}:${key}`,
      passId: pass.id,
    },
    now,
    [d1.prepare(EXTEND_PRO_SQL).bind(at, pass.days, userId)],
  );
  switch (r.status) {
    case "applied":
      return { status: "applied", balance: r.balance, proEndsAt: (await proEnd(d1, userId))! };
    case "duplicate":
      return {
        status: "duplicate",
        balance: await getBalance(d1, userId),
        proEndsAt: await proEnd(d1, userId),
      };
    case "insufficient":
      return insufficient(r.balance);
    case "no user":
      return { status: "rejected", reason: "no user" };
  }
}

// ── Refunds ─────────────────────────────────────────────────────────────────────

export type RefundResult =
  | { status: "refunded"; amount: number; balance: number }
  | { status: "duplicate" }
  | { status: "insufficient"; balance: number }
  | { status: "not found" };

/**
 * Undo a pass bought with credits: the price back to the wallet, the pass's
 * days off `proEndsAt` (never before now). Once per spend: the refund's refId
 * is the spend's.
 */
export async function refundPassToCredits(
  d1: D1WithBatch,
  spendRefId: string,
  now = new Date(),
  note?: string,
): Promise<RefundResult> {
  const spend = await d1
    .prepare("SELECT userId, amount, passId FROM credit_ledger WHERE reason = 'pass' AND refId = ?")
    .bind(spendRefId)
    .first<{ userId: string; amount: number; passId: string | null }>();
  if (!spend) return { status: "not found" };
  const pass = passFor(spend.passId as PassId);
  const amount = -spend.amount;
  const extra = pass
    ? [d1.prepare(SHORTEN_PRO_SQL).bind(now.toISOString(), pass.days, spend.userId)]
    : [];
  const r = await applyCredit(
    d1,
    {
      userId: spend.userId,
      amount,
      reason: "refund",
      refId: `pass:${spendRefId}`,
      passId: spend.passId ?? undefined,
      note,
    },
    now,
    extra,
  );
  if (r.status === "applied") return { status: "refunded", amount, balance: r.balance };
  if (r.status === "duplicate") return { status: "duplicate" };
  return { status: "not found" };
}

/**
 * Take back a top-up whose payment was refunded at the provider. Fails as
 * `insufficient` if the credits were already spent — the balance never goes
 * negative; refund the pass first, or settle the difference by hand.
 */
export async function reverseTopup(
  d1: D1WithBatch,
  topupRefId: string,
  now = new Date(),
  note?: string,
): Promise<RefundResult> {
  const topup = await d1
    .prepare("SELECT userId, amount FROM credit_ledger WHERE reason = 'topup' AND refId = ?")
    .bind(topupRefId)
    .first<{ userId: string; amount: number }>();
  if (!topup) return { status: "not found" };
  const r = await applyCredit(
    d1,
    {
      userId: topup.userId,
      amount: -topup.amount,
      reason: "refund",
      refId: `topup:${topupRefId}`,
      note,
    },
    now,
  );
  if (r.status === "applied")
    return { status: "refunded", amount: -topup.amount, balance: r.balance };
  if (r.status === "duplicate") return { status: "duplicate" };
  if (r.status === "insufficient") return { status: "insufficient", balance: r.balance };
  return { status: "not found" };
}
