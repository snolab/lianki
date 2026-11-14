/**
 * Sign-up bonus over D1 (rules: `signup-bonus.ts`; docs/payments.md,
 * "Sign-up bonus"). An account's grant is one `credit_ledger` row, reason
 * `gift`, refId `signup:<userId>` — UNIQUE (reason, refId), so an account is
 * paid once however often, and however concurrently, it is tried.
 *
 * Two paths, one refId:
 * - **new**: better-auth `user.create.after`. Claims one of the day's slots
 *   (`signup_bonus_day`, UTC): the ledger row goes in only WHERE that day's
 *   `granted` < the cap, the count moves only WHERE EXISTS that very row, and
 *   the balance likewise — one D1 batch, one transaction, so two concurrent
 *   sign-ups can never both be number N.
 * - **backfill**: an account created before the feature went live
 *   (`signup_bonus_launch`, set by migration 0079) gets the same bonus once,
 *   outside the cap, on its next sign-in or wallet read. Accounts created
 *   after launch never qualify here, so missing the cap stays missed.
 *
 * Either path is a no-op while the flag `credits.signup-bonus` is off, never
 * throws into sign-in, and leaves one `security_audit` row per grant.
 */
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import { cfg } from "@/lib/config-store";
import { flagOn } from "@/lib/flags-store";
import { audit, type AuditDb } from "@/lib/security/audit-log";
import type { D1WithBatch } from "./credits-store";
import {
  signupBonusCredits,
  signupBonusSeqOf,
  signupBonusRefId,
  utcDay,
  type SignupBonusConfig,
} from "./signup-bonus";

export type SignupBonusDb = D1WithBatch & AuditDb;
export type SignupBonusPath = "new" | "backfill";

/** The live `credits.signupBonus*` values (defaults when the store is unreadable). */
export async function signupBonusConfig(): Promise<SignupBonusConfig> {
  const [usd, daily] = await Promise.all([
    cfg("credits.signupBonusUsd"),
    cfg("credits.signupBonusDaily"),
  ]);
  return { usd, daily };
}

export type SignupBonusResult =
  | { status: "granted"; credits: number; day: string; seq: number | null }
  /** This account already has its bonus (a retry, a second sign-in). */
  | { status: "already" }
  /** new: the day's slots are taken; backfill: the account is not older than the feature. */
  | { status: "not eligible" }
  /** The amount is 0 (or the cap is 0, for new accounts). */
  | { status: "zero" }
  | { status: "off" };

/**
 * Created before launch: ISO text (what better-auth writes), and — defensively
 * — epoch milliseconds, which the TEXT column would hold as a run of digits.
 */
const BEFORE_LAUNCH = `(CASE WHEN u.createdAt NOT GLOB '*[^0-9.]*' THEN CAST(u.createdAt AS REAL) / 86400000.0 + 2440587.5 ELSE julianday(u.createdAt) END) < (SELECT julianday(at) FROM signup_bonus_launch WHERE id = 1)`;

function balanceStmts(d1: D1Like, id: string, userId: string, credits: number, at: string) {
  return [
    d1
      .prepare(
        "INSERT INTO credit_balance (userId, balance, updatedAt) SELECT ?1, 0, ?2 WHERE EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?3) ON CONFLICT(userId) DO NOTHING",
      )
      .bind(userId, at, id),
    d1
      .prepare(
        "UPDATE credit_balance SET balance = balance + ?1, updatedAt = ?2 WHERE userId = ?3 AND EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?4)",
      )
      .bind(credits, at, userId, id),
  ];
}

/** The statements of a new account's capped claim; `id` is the new ledger row's id. */
function newStmts(
  d1: D1Like,
  g: { id: string; userId: string; credits: number; day: string; cap: number },
  at: string,
): D1StmtLike[] {
  return [
    d1
      .prepare(
        "INSERT INTO signup_bonus_day (day, granted, updatedAt) VALUES (?1, 0, ?2) ON CONFLICT(day) DO NOTHING",
      )
      .bind(g.day, at),
    d1
      .prepare(
        `INSERT OR IGNORE INTO credit_ledger (id, userId, amount, reason, refId, passId, note, createdAt)
         SELECT ?1, ?2, ?3, 'gift', ?4, NULL,
           'signup bonus ' || ?5 || ' #' || ((SELECT granted FROM signup_bonus_day WHERE day = ?5) + 1), ?6
         WHERE EXISTS (SELECT 1 FROM user WHERE id = ?2)
           AND (SELECT granted FROM signup_bonus_day WHERE day = ?5) < ?7`,
      )
      .bind(g.id, g.userId, g.credits, signupBonusRefId(g.userId), g.day, at, g.cap),
    d1
      .prepare(
        "UPDATE signup_bonus_day SET granted = granted + 1, updatedAt = ?1 WHERE day = ?2 AND EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?3)",
      )
      .bind(at, g.day, g.id),
    ...balanceStmts(d1, g.id, g.userId, g.credits, at),
  ];
}

/** The statements of an existing account's backfill (no cap, before launch only). */
function backfillStmts(
  d1: D1Like,
  g: { id: string; userId: string; credits: number },
  at: string,
): D1StmtLike[] {
  return [
    d1
      .prepare(
        `INSERT OR IGNORE INTO credit_ledger (id, userId, amount, reason, refId, passId, note, createdAt)
         SELECT ?1, ?2, ?3, 'gift', ?4, NULL, 'signup bonus (existing account)', ?5
         FROM user u WHERE u.id = ?2 AND ${BEFORE_LAUNCH}`,
      )
      .bind(g.id, g.userId, g.credits, signupBonusRefId(g.userId), at),
    ...balanceStmts(d1, g.id, g.userId, g.credits, at),
  ];
}

async function hasBonus(d1: D1Like, userId: string): Promise<boolean> {
  return (
    (await d1
      .prepare("SELECT 1 AS x FROM credit_ledger WHERE reason = 'gift' AND refId = ?")
      .bind(signupBonusRefId(userId))
      .first()) !== null
  );
}

async function beforeLaunch(d1: D1Like, userId: string): Promise<boolean> {
  return (
    (await d1
      .prepare(`SELECT 1 AS x FROM user u WHERE u.id = ? AND ${BEFORE_LAUNCH}`)
      .bind(userId)
      .first()) !== null
  );
}

/**
 * Grant the bonus on one path, flag and config already decided. Idempotent:
 * once an account has its row, every later call is `already`.
 */
export async function grantSignupBonus(
  d1: SignupBonusDb,
  userId: string,
  path: SignupBonusPath,
  conf: SignupBonusConfig,
  now = new Date(),
): Promise<SignupBonusResult> {
  const credits = signupBonusCredits(conf);
  if (credits <= 0 || (path === "new" && conf.daily <= 0)) return { status: "zero" };
  // The cheap read first: every sign-in and wallet read of a paid account stops here.
  if (await hasBonus(d1, userId)) return { status: "already" };
  // Only accounts older than the feature are backfilled; read before writing.
  if (path === "backfill" && !(await beforeLaunch(d1, userId))) return { status: "not eligible" };
  const at = now.toISOString();
  const id = crypto.randomUUID();
  const day = utcDay(now);
  await d1.batch(
    path === "new"
      ? newStmts(d1, { id, userId, credits, day, cap: Math.floor(conf.daily) }, at)
      : backfillStmts(d1, { id, userId, credits }, at),
  );
  // The slot this account took is in its own row's note (written in the batch).
  const row = await d1
    .prepare("SELECT note FROM credit_ledger WHERE id = ?")
    .bind(id)
    .first<{ note: string | null }>();
  if (!row)
    return (await hasBonus(d1, userId)) ? { status: "already" } : { status: "not eligible" };
  const seq = path === "new" ? signupBonusSeqOf(row.note) : null;
  await audit(
    d1,
    {
      kind: "credits.signup-bonus",
      actor: userId,
      subject: userId,
      detail: `${path} ${day}${seq ? ` #${seq}` : ""} +${credits}`,
    },
    now.getTime(),
  );
  return { status: "granted", credits, day, seq };
}

export interface SignupBonusDeps {
  now?: Date;
  /** Defaults to the live flag `credits.signup-bonus`. */
  enabled?: () => Promise<boolean>;
  /** Defaults to the live `credits.signupBonus*` config. */
  conf?: () => Promise<SignupBonusConfig>;
}

/**
 * The hook entry: the flag (the owner's off switch for both paths), the live
 * config, then the grant. Never throws — a failed bonus never fails a sign-up,
 * a sign-in or a wallet read; it is logged as `signup-bonus: grant failed`.
 */
export async function runSignupBonus(
  d1: SignupBonusDb,
  userId: string,
  path: SignupBonusPath,
  deps: SignupBonusDeps = {},
): Promise<SignupBonusResult | null> {
  try {
    if (!(await (deps.enabled ?? (() => flagOn("credits.signup-bonus")))()))
      return { status: "off" };
    const conf = await (deps.conf ?? signupBonusConfig)();
    return await grantSignupBonus(d1, userId, path, conf, deps.now);
  } catch (e) {
    console.error("signup-bonus: grant failed", path, e);
    return null;
  }
}

/**
 * The better-auth database hooks (`auth-impl.ts`): a new user row claims a
 * capped slot; every new session (a sign-in) runs the backfill, which pays
 * only accounts older than the feature and stops at one read once paid.
 * `db` is null off D1 (the Mongo rollback copy is never written).
 */
export function signupBonusHooks(db: () => SignupBonusDb | null, deps?: SignupBonusDeps) {
  return {
    userCreated: async (user: { id: string }) => {
      const d1 = db();
      if (d1) await runSignupBonus(d1, user.id, "new", deps);
    },
    sessionCreated: async (session: { userId: string }) => {
      const d1 = db();
      if (d1) await runSignupBonus(d1, session.userId, "backfill", deps);
    },
  };
}
