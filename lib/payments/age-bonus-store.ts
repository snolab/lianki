/**
 * Account-age bonus over D1 (rules: `age-bonus.ts`; docs/payments.md,
 * "Account-age bonus"). Each tier is one `credit_ledger` row, reason `gift`,
 * refId `agebonus:<tier>:<userId>` — UNIQUE (reason, refId), so a tier is
 * granted once however often, and however concurrently, it is tried.
 *
 * The statements are race-proof on their own, like `creditTopup`: the ledger
 * row is INSERT OR IGNORE (a second try inserts nothing), and the balance
 * moves only WHERE EXISTS that very row. So a whole batch of grants never fails
 * because one of them was taken meanwhile (by a sign-in during the backfill).
 */
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import { cfg } from "@/lib/config-store";
import {
  ageBonusRefId,
  createdAtMs,
  firstTierHours,
  tiersOwed,
  type AgeBonusConfig,
  type AgeTier,
} from "./age-bonus";
import type { D1WithBatch } from "./credits-store";

const HOUR = 60 * 60 * 1000;

/** The live `credits.ageBonus.*` values (defaults when the store is unreadable). */
export async function ageBonusConfig(): Promise<AgeBonusConfig> {
  const [day1Usd, day7Usd, day1Hours, day7Hours] = await Promise.all([
    cfg("credits.ageBonus.day1Usd"),
    cfg("credits.ageBonus.day7Usd"),
    cfg("credits.ageBonus.day1Hours"),
    cfg("credits.ageBonus.day7Hours"),
  ]);
  return { day1Usd, day7Usd, day1Hours, day7Hours };
}

/** One grant's statements; `id` is the new ledger row's id. */
function grantStmts(
  d1: D1Like,
  g: { id: string; userId: string; tier: AgeTier; credits: number },
  at: string,
): D1StmtLike[] {
  return [
    d1
      .prepare(
        "INSERT OR IGNORE INTO credit_ledger (id, userId, amount, reason, refId, passId, note, createdAt) SELECT ?1, ?2, ?3, 'gift', ?4, NULL, ?5, ?6 WHERE EXISTS (SELECT 1 FROM user WHERE id = ?2)",
      )
      .bind(g.id, g.userId, g.credits, ageBonusRefId(g.tier, g.userId), `age bonus ${g.tier}`, at),
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

/** How many of `ids` are now ledger rows (≤ 50 ids: D1 binds at most 100). */
async function inserted(d1: D1Like, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { results } = await d1
    .prepare(`SELECT id FROM credit_ledger WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

export interface AgeGrantResult {
  granted: AgeTier[];
  credits: number;
}

/**
 * Grant whatever tiers this account is owed now. Cheap when there is nothing
 * to do: one user row read, and for an old enough account one indexed lookup
 * of its two refIds. Called on sign-in and on every wallet read.
 */
export async function grantAgeBonus(
  d1: D1WithBatch,
  userId: string,
  now = new Date(),
  conf?: AgeBonusConfig,
): Promise<AgeGrantResult> {
  const none: AgeGrantResult = { granted: [], credits: 0 };
  const c = conf ?? (await ageBonusConfig());
  const user = await d1
    .prepare("SELECT createdAt FROM user WHERE id = ?")
    .bind(userId)
    .first<{ createdAt: unknown }>();
  const born = createdAtMs(user?.createdAt);
  if (born === null || now.getTime() - born < firstTierHours(c) * HOUR) return none;
  const { results } = await d1
    .prepare("SELECT refId FROM credit_ledger WHERE reason = 'gift' AND refId IN (?, ?)")
    .bind(ageBonusRefId("d1", userId), ageBonusRefId("d7", userId))
    .all<{ refId: string }>();
  const done = results.map((r) => r.refId.split(":")[1] as AgeTier);
  const owed = tiersOwed(user!.createdAt, now, c, done);
  if (!owed.length) return none;
  const at = now.toISOString();
  const grants = owed.map((o) => ({ ...o, userId, id: crypto.randomUUID() }));
  await d1.batch(grants.flatMap((g) => grantStmts(d1, g, at)));
  const got = await inserted(
    d1,
    grants.map((g) => g.id),
  );
  const mine = grants.filter((g) => got.has(g.id));
  return { granted: mine.map((g) => g.tier), credits: mine.reduce((s, g) => s + g.credits, 0) };
}

export interface AgeBonusPlan {
  /** Accounts owed the first tier / the second tier now. */
  usersD1: number;
  usersD7: number;
  /** Accounts owed anything. */
  users: number;
  credits: number;
}

type Owed = { userId: string; tier: AgeTier; credits: number };

/** Every grant owed now, across all accounts (paged by id; reads only). */
async function owedAll(d1: D1Like, now: Date, c: AgeBonusConfig, page = 500): Promise<Owed[]> {
  const out: Owed[] = [];
  let last = "";
  for (;;) {
    const { results } = await d1
      .prepare(
        `SELECT u.id, u.createdAt,
           EXISTS (SELECT 1 FROM credit_ledger l WHERE l.reason = 'gift' AND l.refId = 'agebonus:d1:' || u.id) AS hasD1,
           EXISTS (SELECT 1 FROM credit_ledger l WHERE l.reason = 'gift' AND l.refId = 'agebonus:d7:' || u.id) AS hasD7
         FROM user u WHERE u.id > ? ORDER BY u.id LIMIT ?`,
      )
      .bind(last, page)
      .all<{ id: string; createdAt: unknown; hasD1: number; hasD7: number }>();
    for (const r of results) {
      const done: AgeTier[] = [];
      if (Number(r.hasD1)) done.push("d1");
      if (Number(r.hasD7)) done.push("d7");
      for (const o of tiersOwed(r.createdAt, now, c, done)) out.push({ userId: r.id, ...o });
    }
    if (results.length < page) return out;
    last = results[results.length - 1]!.id;
  }
}

function summarize(owed: Owed[]): AgeBonusPlan {
  return {
    usersD1: owed.filter((o) => o.tier === "d1").length,
    usersD7: owed.filter((o) => o.tier === "d7").length,
    users: new Set(owed.map((o) => o.userId)).size,
    credits: owed.reduce((s, o) => s + o.credits, 0),
  };
}

/** What a backfill would grant now. Writes nothing. */
export async function previewAgeBonus(
  d1: D1Like,
  now = new Date(),
  conf?: AgeBonusConfig,
): Promise<AgeBonusPlan> {
  return summarize(await owedAll(d1, now, conf ?? (await ageBonusConfig())));
}

export interface AgeBonusApplied extends AgeBonusPlan {
  /** Grants that failed (their batch threw); a re-run picks them up. */
  failed: number;
}

/**
 * The one-time backfill: grant every tier owed now, `chunk` grants per D1
 * batch. Idempotent — a re-run (or a sign-in racing it) grants nothing twice;
 * the counts are what this run actually granted.
 */
export async function applyAgeBonus(
  d1: D1WithBatch,
  now = new Date(),
  conf?: AgeBonusConfig,
  chunk = 40,
): Promise<AgeBonusApplied> {
  const owed = await owedAll(d1, now, conf ?? (await ageBonusConfig()));
  const at = now.toISOString();
  const done: Owed[] = [];
  let failed = 0;
  for (let i = 0; i < owed.length; i += chunk) {
    const grants = owed.slice(i, i + chunk).map((o) => ({ ...o, id: crypto.randomUUID() }));
    try {
      await d1.batch(grants.flatMap((g) => grantStmts(d1, g, at)));
      const got = await inserted(
        d1,
        grants.map((g) => g.id),
      );
      done.push(...grants.filter((g) => got.has(g.id)));
    } catch (e) {
      failed += grants.length;
      console.error(JSON.stringify({ event: "credits.ageBonus.batch", error: String(e) }));
    }
  }
  return { ...summarize(done), failed };
}
