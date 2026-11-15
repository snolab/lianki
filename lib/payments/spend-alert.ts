/**
 * The spend alert (docs/payments.md, "Spend alert"; owner, 2026-11-15): each
 * time what the AI/TTS/STT calls cost us passes the next whole step
 * (config `partner.spendAlertStepUsd`, default $1), one line in the owner's
 * thread — for the whole site, and for his own account.
 *
 * Every cost the main Worker records comes through here: a cost_ledger row
 * (`bookCost`, the free calls) and a settled paid charge (`settleAi`, the
 * Learning Partner and the metered features), at the provider's cost. Two
 * counters take it, rows of `spend_alert`: 'site' and 'user:<id>'. A counter
 * whose total passed a step its row has not announced claims that step with a
 * guarded UPDATE (`last_micro` only moves up), so one step is posted once
 * however many calls cross it together. Only then is anything else read: the
 * flag, whether the account holds admin or dev (a 'user:' counter of anyone
 * else, or any counter with the flag off, claims the step silently), the
 * day's and month's totals (UTC), the line's text. A post that fails gives
 * the step back for the next call.
 *
 * Never throws and never fails the call that cost it: errors are logged
 * (`spend.alert.failed`, the step only).
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { D1Like } from "@/lib/d1/types";
import { configLive, flagLive } from "@/lib/debug-session";
import { holdsSql } from "@/lib/account-permission";
import { dayStartMs, localDay } from "@/lib/time-zone";
import { CREDITS_PER_USD } from "./credits";
import { MARGIN } from "./prices";
import {
  SPEND_ALERT_FLAG,
  SPEND_ALERT_PATH,
  SPEND_MINE_TEXT,
  SPEND_SITE_TEXT,
  SPEND_STEP_MAX,
  SPEND_STEP_MIN,
  SPEND_STEP_USD,
} from "./spend-alert-config";

export type SpendScope = "site" | `user:${string}`;
type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };
type Log = (o: Record<string, unknown>) => void;

export type SpendDeps = {
  /** The hub (the PUSH binding); default: the Worker's, when there is one. */
  push?: Fetcher | null;
  now?: Date;
  log?: Log;
};

/** credit_ai_charge.costMicro (millionths of a credit at our price) → provider USD micro. */
export const paidUsdMicro = (costMicro: number) => costMicro / CREDITS_PER_USD / MARGIN;

/** The step size in USD micro: the config value clamped to its range; junk = the default. */
export function stepMicro(stepUsd: unknown): number {
  const v = typeof stepUsd === "number" && Number.isFinite(stepUsd) ? stepUsd : SPEND_STEP_USD;
  return Math.round(Math.min(SPEND_STEP_MAX, Math.max(SPEND_STEP_MIN, v)) * 1e6);
}

/**
 * The step to announce, USD micro: the highest multiple of `step` that
 * `total` has reached, when it is above `last` (the step announced before);
 * otherwise null. Several steps crossed at once are one step: the highest.
 * A changed step size never repeats a line: `last` is an amount, not a count.
 */
export function crossedStep(last: number, total: number, step: number): number | null {
  if (!(step > 0) || !Number.isFinite(total) || !Number.isFinite(last)) return null;
  // A hair of slack: a sum of REAL millionths lands a little under a whole step.
  const reached = Math.floor(total / step + 1e-9) * step;
  return reached > 0 && reached > last ? reached : null;
}

/** USD micro as the line shows it: the step "3" or "1.5", the totals "0.42". */
export const stepText = (micro: number) => String(Number((micro / 1e6).toFixed(2)));
export const usdText = (micro: number) => (Math.max(0, micro) / 1e6).toFixed(2);

/** The line: `template` with {n}, {today} and {month} filled in (every occurrence). */
export function spendLine(
  template: string,
  v: { n: number; today: number; month: number },
): string {
  return template
    .replaceAll("{n}", stepText(v.n))
    .replaceAll("{today}", usdText(v.today))
    .replaceAll("{month}", usdText(v.month));
}

/** The UTC instants and cost_ledger.day bounds of today and of this month. */
export function spendWindows(now: Date) {
  const today = localDay(now, 0);
  const win = (from: string) => {
    const start = dayStartMs(from, 0);
    const end = dayStartMs(today, 0) + 86400_000;
    return {
      startIso: new Date(start).toISOString(),
      endIso: new Date(end).toISOString(),
      // A day wider each side: rows before 2026-11-15 hold the JST date.
      fromDay: localDay(start - 86400_000, 0),
      toDay: localDay(end + 86400_000, 0),
    };
  };
  return { today: win(today), month: win(`${today.slice(0, 7)}-01`) };
}

/** What a scope spent in a window, USD micro: free (cost_ledger) + paid (settled charges). */
async function spentIn(
  d1: D1Like,
  userId: string | null,
  w: ReturnType<typeof spendWindows>["today"],
): Promise<number> {
  const mine = userId !== null;
  const [free, paid] = await Promise.all([
    d1
      .prepare(
        `SELECT COALESCE(SUM(usd_micro), 0) AS m FROM cost_ledger WHERE day BETWEEN ? AND ? AND at >= ? AND at < ?${mine ? " AND user_id = ?" : ""}`,
      )
      .bind(w.fromDay, w.toDay, w.startIso, w.endIso, ...(mine ? [userId] : []))
      .first<{ m: number }>(),
    d1
      .prepare(
        `SELECT COALESCE(SUM(costMicro), 0) AS cm FROM credit_ai_charge WHERE status = 'settled' AND settledAt >= ? AND settledAt < ?${mine ? " AND userId = ?" : ""}`,
      )
      .bind(w.startIso, w.endIso, ...(mine ? [userId] : []))
      .first<{ cm: number }>(),
  ]);
  return Number(free?.m ?? 0) + paidUsdMicro(Number(paid?.cm ?? 0));
}

/** Does this account hold admin or dev right now (lib/account-permission.ts)? */
async function isOwnerAccount(d1: D1Like, userId: string): Promise<boolean> {
  const row = await d1
    .prepare(
      `SELECT 1 AS o FROM user u WHERE u.id = ? AND (${holdsSql("u.id", "admin")} OR ${holdsSql("u.id", "dev")})`,
    )
    .bind(userId)
    .first<{ o: number }>();
  return Boolean(row);
}

function workerPush(): Fetcher | null {
  try {
    // Off the Worker (tests, scripts) there is no context: it throws.
    return (getCloudflareContext().env as unknown as { PUSH?: Fetcher }).PUSH ?? null;
  } catch {
    return null;
  }
}

const changed = (r: unknown) =>
  Number((r as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);

export type SpendPost = { scope: SpendScope; step: number; text: string };

/**
 * `usdMicro` of provider cost was just recorded for `userId` (null or '' = a
 * guest: the site counter only). Adds it to the counters and posts the steps
 * they passed. Answers the lines posted. Never throws.
 */
export async function recordSpend(
  d1: D1Like | null | undefined,
  userId: string | null | undefined,
  usdMicro: number,
  deps: SpendDeps = {},
): Promise<SpendPost[]> {
  const posted: SpendPost[] = [];
  if (!d1 || !(usdMicro > 0) || !Number.isFinite(usdMicro)) return posted;
  const log = deps.log ?? ((o) => console.log(JSON.stringify(o)));
  const now = deps.now ?? new Date();
  const at = now.toISOString();
  const scopes: SpendScope[] = ["site", ...(userId ? [`user:${userId}` as const] : [])];
  let step: number | undefined;
  let push: Fetcher | null | undefined = deps.push;
  for (const scope of scopes) {
    let claimed: { prev: number; step: number } | null = null;
    try {
      const row = await d1
        .prepare(
          "INSERT INTO spend_alert (scope, total_micro, last_micro, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(scope) DO UPDATE SET total_micro = total_micro + excluded.total_micro, updated_at = excluded.updated_at RETURNING total_micro AS total, last_micro AS last",
        )
        .bind(scope, usdMicro, at)
        .first<{ total: number; last: number }>();
      if (!row) continue;
      step ??= stepMicro(await configLive(d1, "partner.spendAlertStepUsd"));
      const reached = crossedStep(Number(row.last), Number(row.total), step);
      if (reached === null) continue;
      // Nowhere to post (a script, a test): leave the step for a call that can.
      if (push === undefined) push = workerPush();
      if (!push) continue;
      const claim = await d1
        .prepare(
          "UPDATE spend_alert SET last_micro = ?, updated_at = ? WHERE scope = ? AND last_micro < ?",
        )
        .bind(reached, at, scope, reached)
        .run();
      if (changed(claim) !== 1) continue; // another call announced it
      claimed = { prev: Number(row.last), step: reached };
      // Off, or not his account: the step is passed silently (never posted later).
      if (!(await flagLive(d1, SPEND_ALERT_FLAG))) continue;
      const uid = scope === "site" ? null : scope.slice(5);
      if (uid !== null && !(await isOwnerAccount(d1, uid))) continue;
      const w = spendWindows(now);
      const [today, month, template] = await Promise.all([
        spentIn(d1, uid, w.today),
        spentIn(d1, uid, w.month),
        configLive(d1, uid === null ? "partner.spendAlertSiteText" : "partner.spendAlertMineText"),
      ]);
      const fallback = uid === null ? SPEND_SITE_TEXT : SPEND_MINE_TEXT;
      const text = spendLine(typeof template === "string" ? template : fallback, {
        n: reached,
        today,
        month,
      });
      const res = await push.fetch(`https://lianki-push${SPEND_ALERT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: uid === null ? "site" : "mine", step: reached / 1e6, text }),
      });
      if (!res.ok) throw new Error(`lianki-push ${res.status}`);
      posted.push({ scope, step: reached, text });
      log({ event: "spend.alert", scope: uid === null ? "site" : "mine", step: reached / 1e6 });
    } catch (err) {
      log({
        event: "spend.alert.failed",
        scope: scope === "site" ? "site" : "user",
        ...(claimed ? { step: claimed.step / 1e6 } : {}),
        error: String((err as Error)?.message ?? err).slice(0, 200),
      });
      // Not posted: give the step back, unless a later one was claimed since.
      if (claimed)
        try {
          await d1
            .prepare("UPDATE spend_alert SET last_micro = ? WHERE scope = ? AND last_micro = ?")
            .bind(claimed.prev, scope, claimed.step)
            .run();
        } catch {}
    }
  }
  return posted;
}
