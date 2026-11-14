/**
 * Login-streak bonus over D1 (rules: `login-streak.ts`; docs/payments.md,
 * "Login-streak bonus"). A day's grant is one `credit_ledger` row, reason
 * `gift`, refId `streak:<userId>:<day>` — UNIQUE (reason, refId), so a day is
 * paid once however often, and however concurrently, it is tried. The streak
 * row (`login_streak`) moves only forward (`WHERE day < the new day`), in the
 * same D1 batch, so the state and the grant never disagree.
 *
 * Race-proof like `creditTopup`: the ledger row is INSERT OR IGNORE, and the
 * balance moves only WHERE EXISTS that very row.
 */
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import { cfg } from "@/lib/config-store";
import {
  currentStreak,
  cycleStep,
  nextStreak,
  parseUsdByDay,
  stepCredits,
  streakRefId,
  type StreakConfig,
  type StreakState,
} from "./login-streak";
import type { D1WithBatch } from "./credits-store";

/** The live `credits.loginStreak.*` values (defaults when the store is unreadable). */
export async function loginStreakConfig(): Promise<StreakConfig> {
  const [usdByDay, missCostDays] = await Promise.all([
    cfg("credits.loginStreak.usdByDay"),
    cfg("credits.loginStreak.missCostDays"),
  ]);
  return { usdByDay: parseUsdByDay(usdByDay), missCostDays };
}

type StreakRow = { day: string; tz: string; streak: number };

async function readState(d1: D1Like, userId: string): Promise<StreakRow | null> {
  return d1
    .prepare("SELECT day, tz, streak FROM login_streak WHERE userId = ?")
    .bind(userId)
    .first<StreakRow>();
}

/** One grant's statements; `id` is the new ledger row's id. */
function grantStmts(
  d1: D1Like,
  g: { id: string; userId: string; day: string; step: number; streak: number; credits: number },
  at: string,
): D1StmtLike[] {
  return [
    d1
      .prepare(
        "INSERT OR IGNORE INTO credit_ledger (id, userId, amount, reason, refId, passId, note, createdAt) SELECT ?1, ?2, ?3, 'gift', ?4, NULL, ?5, ?6 WHERE EXISTS (SELECT 1 FROM user WHERE id = ?2)",
      )
      .bind(
        g.id,
        g.userId,
        g.credits,
        streakRefId(g.userId, g.day),
        `login streak day ${g.step} (${g.streak})`,
        at,
      ),
    d1
      .prepare(
        "INSERT INTO credit_balance (userId, balance, updatedAt) SELECT ?1, 0, ?2 WHERE EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?3) ON CONFLICT(userId) DO NOTHING",
      )
      .bind(g.userId, at, g.id),
    d1
      .prepare(
        "UPDATE credit_balance SET balance = balance + ?1, updatedAt = ?2 WHERE userId = ?3 AND EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?4)",
      )
      .bind(g.credits, at, g.userId, g.id),
  ];
}

/** The streak row moves forward only: a stale or repeated write changes nothing. */
function stateStmt(
  d1: D1Like,
  s: { userId: string; day: string; tz: string; streak: number },
  at: string,
): D1StmtLike {
  return d1
    .prepare(
      `INSERT INTO login_streak (userId, day, tz, streak, updatedAt)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM user WHERE id = ?1)
       ON CONFLICT(userId) DO UPDATE SET day = excluded.day, tz = excluded.tz, streak = excluded.streak, updatedAt = excluded.updatedAt
       WHERE login_streak.day < excluded.day`,
    )
    .bind(s.userId, s.day, s.tz, s.streak, at);
}

export interface StreakGrant {
  /** The streak after this day was counted (0 = nothing counted: already done, or no such user). */
  streak: number;
  step: number;
  /** Credits this call put in the wallet (0 on a repeat, a 0-amount step, or a lost race). */
  credits: number;
  missed: number;
}

const NONE: StreakGrant = { streak: 0, step: 0, credits: 0, missed: 0 };

/**
 * Count `day` (YYYY-MM-DD, local to `tz`) for this account and pay its cycle
 * step. Idempotent: the second call for the same day — a retry, a second
 * review that day, a concurrent request — changes nothing and pays nothing.
 */
export async function recordLoginStreak(
  d1: D1WithBatch,
  userId: string,
  day: string,
  tz: string,
  now = new Date(),
  conf?: StreakConfig,
): Promise<StreakGrant> {
  const c = conf ?? (await loginStreakConfig());
  const prev = await readState(d1, userId);
  const next = nextStreak(prev, day, c);
  if (!next) return NONE;
  const at = now.toISOString();
  const id = crypto.randomUUID();
  const stmts = [stateStmt(d1, { userId, day, tz, streak: next.streak }, at)];
  if (next.credits > 0) stmts.push(...grantStmts(d1, { id, userId, day, ...next }, at));
  await d1.batch(stmts);
  // What this call actually did: the state row names the winner's day; the
  // ledger row with our id exists only if our insert was the one kept.
  const after = await readState(d1, userId);
  if (!after || after.day !== day) return NONE;
  const mine =
    next.credits > 0 &&
    (await d1.prepare("SELECT 1 AS x FROM credit_ledger WHERE id = ?").bind(id).first()) !== null;
  return {
    streak: after.streak,
    step: cycleStep(after.streak, c),
    credits: mine ? next.credits : 0,
    missed: next.missed,
  };
}

export interface StreakView {
  /** Consecutive days held as of `today` (after the miss rule when days were skipped). */
  days: number;
  /** Whether today already counted. */
  today: boolean;
  /** Credits paid today, or — when today has not counted yet — what counting it would pay. */
  credits: number;
  /** The cycle step today pays or would pay, and the cycle length. */
  step: number;
  cycle: number;
}

/** The streak as the wallet shows it on `today` (YYYY-MM-DD in the account's home zone). */
export async function loginStreakView(
  d1: D1Like,
  userId: string,
  today: string,
  conf?: StreakConfig,
): Promise<StreakView> {
  const c = conf ?? (await loginStreakConfig());
  const prev: StreakState | null = await readState(d1, userId);
  const cycle = Math.max(1, c.usdByDay.length);
  if (prev && prev.day === today) {
    const step = cycleStep(prev.streak, c);
    return { days: prev.streak, today: true, credits: stepCredits(step, c), step, cycle };
  }
  const next = nextStreak(prev, today, c);
  const days = currentStreak(prev, today, c);
  return {
    days,
    today: false,
    credits: next?.credits ?? 0,
    step: next?.step ?? cycleStep(days + 1, c),
    cycle,
  };
}
