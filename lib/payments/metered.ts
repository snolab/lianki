/**
 * Every paid provider call a user makes, paid from that user's credits
 * (docs/payments.md, "What costs credits"). Pre-authorisation + refund, the
 * owner's rule (2026-11-09):
 *
 * 1. **Sweep.** This user's holds still pending after `HOLD_STALE_MS` belong
 *    to a call that crashed before settling: released (refunded in full).
 *    Event-driven: on the user's next paid request, never a timer.
 * 2. **Hold.** The most the call can cost (`holdUsd`, from the same limits the
 *    call is made with: max output tokens, text length, audio size) is debited
 *    in whole credits — `reserveAi` in lib/payments/ai-credits.ts, one D1
 *    batch whose balance UPDATE trips `CHECK (balance >= 0)`, so concurrent
 *    holds cannot overdraw. Too little → `no-credits`, the provider is never
 *    called.
 * 3. **Call.** `run()` makes the call within those limits and says what it
 *    cost (`usd`). It throws → full refund, and the error goes on.
 * 4. **Settle.** The real cost is kept (fractions carry), the rest refunded
 *    under the same refId. The hold is a hard cap: a reported cost above it
 *    (pricing drift) is logged `credits.overage` and settled at the hold —
 *    never charged past it.
 *
 * Free, with no ledger row: an `admin` (lib/permissions.ts — the people who pay
 * the provider), and calls made with the user's own key (BYOK) never come here.
 * Without D1 (the frozen Mongo backend, local dev) nothing can be charged:
 * the call runs unmetered and says so in the log.
 */
import { isAdmin } from "@/lib/permissions";
import { reserveAi, reserveCredits, settleAi, sweepStaleAi, usdToMicroCredits } from "./ai-credits";
import type { D1WithBatch } from "./credits-store";
import { CREDITS_HEADER, CREDITS_NEEDED } from "./no-credits-watch";
import { CREDITS_PAUSED } from "./no-credits-watch";
import { PRICES_VERSION, type Feature } from "./prices";

/** No paid call lasts near this long: a hold older than this is a crashed call's. */
export const HOLD_STALE_MS = 10 * 60_000;

export type Payer = { userId: string; email?: string | null };

export type Metered<T> =
  | { ok: true; value: T; charged: number; free?: "admin" | "unmetered" | "feature" }
  | { ok: false; reason: "no-credits"; balance: number; need: number }
  | { ok: false; reason: "paused" }
  | { ok: false; reason: "duplicate" };

export type MeterDeps = {
  d1: D1WithBatch | null;
  now?: () => Date;
  log?: (o: Record<string, unknown>) => void;
  /** Is this payer an admin? Defaults to the permission snapshot. */
  admin?: (email: string | null | undefined) => boolean;
};

/** A taken hold (or a free pass), to settle once the call is done. */
export type Hold = {
  what: Feature;
  holdUsd: number;
  key: string;
  d1: D1WithBatch | null;
  free?: "admin" | "unmetered";
};

type Refusal = Exclude<Metered<unknown>, { ok: true }>;

/**
 * Steps 1–2: refuse a paused feature, release stale holds, take this call's
 * hold — or a free pass for an admin, or with no wallet in reach.
 */
export async function takeHold(
  deps: MeterDeps,
  payer: Payer,
  call: { what: Feature; holdUsd: number; key?: string },
): Promise<{ ok: true; hold: Hold } | Refusal> {
  const now = deps.now ?? (() => new Date());
  const admin = deps.admin ?? isAdmin;
  const key = `${call.what}:${payer.userId}:${call.key ?? crypto.randomUUID()}`;
  const base = { what: call.what, holdUsd: call.holdUsd, key, d1: deps.d1 };
  // Paused after an overage, until the price table is updated: no call, no charge.
  if (deps.d1 && (await isPaused(deps.d1, call.what))) return { ok: false, reason: "paused" };
  if (admin(payer.email)) return { ok: true, hold: { ...base, free: "admin" } };
  if (!deps.d1) return { ok: true, hold: { ...base, free: "unmetered" } };
  const d1 = deps.d1;
  try {
    await sweepStaleAi(d1, HOLD_STALE_MS, now());
  } catch {}
  const need = reserveCredits(call.holdUsd);
  const r = await reserveAi(
    d1,
    { userId: payer.userId, key, reserved: need, what: call.what },
    now(),
  );
  if (r.status === "duplicate") return { ok: false, reason: "duplicate" };
  if (r.status !== "reserved")
    return {
      ok: false,
      reason: "no-credits",
      balance: r.status === "insufficient" ? r.balance : 0,
      need,
    };
  return { ok: true, hold: base };
}

/**
 * Step 4: settle a hold at `usd` (null: the provider failed — nothing kept).
 * Never past the hold; an overage pauses the feature. Answers whole credits kept.
 */
export async function settleHold(
  hold: Hold,
  usd: number | null,
  deps: Pick<MeterDeps, "now" | "log"> = {},
): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((o) => console.log(JSON.stringify(o)));
  if (usd !== null) await overage(hold.d1, hold, usd, now(), log);
  if (hold.free) {
    log({
      event: hold.free === "admin" ? "credits.free" : "credits.unmetered",
      what: hold.what,
      ...(hold.free === "admin" ? { why: "admin" } : {}),
      usd: usd ?? 0,
    });
    return 0;
  }
  const cap = usdToMicroCredits(hold.holdUsd);
  const cost = usd === null ? 0 : Math.min(cap, usdToMicroCredits(usd));
  // A failed settle leaves the hold pending for the next request's sweep (full refund).
  const settled = hold.d1 ? await settleSafe(hold.d1, hold.key, cost, now()) : null;
  return settled?.charged ?? 0;
}

/**
 * Hold `holdUsd` for `what`, run the call, settle its real cost. `key` makes a
 * retried request a no-op (`duplicate`); by default each call is its own.
 */
export async function metered<T>(
  deps: MeterDeps,
  payer: Payer,
  call: { what: Feature; holdUsd: number; key?: string },
  run: () => Promise<{ value: T; usd: number }>,
): Promise<Metered<T>> {
  const h = await takeHold(deps, payer, call);
  if (!h.ok) return h;
  let r: { value: T; usd: number };
  try {
    r = await run();
  } catch (err) {
    // The provider failed: nothing kept.
    await settleHold(h.hold, null, deps);
    throw err;
  }
  const charged = await settleHold(h.hold, r.usd, deps);
  return { ok: true, value: r.value, charged, ...(h.hold.free ? { free: h.hold.free } : {}) };
}

/** Is `what` paused under the current price table? Unreadable (no table yet): not paused. */
export async function isPaused(d1: D1WithBatch, what: Feature): Promise<boolean> {
  try {
    const row = await d1
      .prepare("SELECT 1 AS p FROM credit_feature_pause WHERE feature = ? AND version = ?")
      .bind(what, PRICES_VERSION)
      .first<{ p: number }>();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * A call cost more than its hold: the price table no longer covers this
 * feature. Alert (`credits.overage`, amounts only) and pause the feature for
 * everyone until PRICES_VERSION changes — never keep running at a loss.
 */
async function overage(
  d1: D1WithBatch | null,
  call: { what: Feature; holdUsd: number },
  usd: number,
  at: Date,
  log: (o: Record<string, unknown>) => void,
) {
  if (usdToMicroCredits(usd) <= usdToMicroCredits(call.holdUsd)) return;
  log({ event: "credits.overage", what: call.what, usd, holdUsd: call.holdUsd, paused: !!d1 });
  console.error(JSON.stringify({ event: "credits.overage.paused", what: call.what }));
  if (!d1) return;
  try {
    await d1
      .prepare(
        "INSERT INTO credit_feature_pause (feature, version, usd, holdUsd, createdAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(feature) DO UPDATE SET version = excluded.version, usd = excluded.usd, holdUsd = excluded.holdUsd, createdAt = excluded.createdAt",
      )
      .bind(call.what, PRICES_VERSION, usd, call.holdUsd, at.toISOString())
      .run();
  } catch {}
}

async function settleSafe(d1: D1WithBatch, key: string, micro: number, at: Date) {
  try {
    return await settleAi(d1, key, micro, at);
  } catch {
    return null;
  }
}

/** A paused feature: 503, "temporarily unavailable" on the page; nothing charged. */
export const pausedResponse = () =>
  Response.json(
    { error: "credits-paused" },
    { status: 503, headers: { "cache-control": "no-store", [CREDITS_HEADER]: CREDITS_PAUSED } },
  );

/** The top-up page a refusal points to. */
export const TOP_UP_PATH = "/membership";

/** A refusal as the routes answer it: 402, machine-readable; the page shows the translated words. */
export function noCreditsResponse(r: { balance: number; need: number }): Response {
  return Response.json(
    { error: "no-credits", balance: r.balance, need: r.need, topUp: TOP_UP_PATH },
    { status: 402, headers: { "cache-control": "no-store", [CREDITS_HEADER]: CREDITS_NEEDED } },
  );
}

/** A retried request already being (or been) paid: 409, nothing done twice. */
export const duplicateResponse = () =>
  Response.json({ error: "duplicate" }, { status: 409, headers: { "cache-control": "no-store" } });

/** The refusal for any `ok: false` outcome. */
export const refusal = (r: Exclude<Metered<unknown>, { ok: true }>) =>
  r.reason === "no-credits"
    ? noCreditsResponse(r)
    : r.reason === "paused"
      ? pausedResponse()
      : duplicateResponse();

/** What a seam function returns when the wallet said no (no call was made). */
export type Refused =
  | { ok: false; error: "no-credits"; balance: number; need: number }
  | { ok: false; error: "credits-paused" };

/** A refusal as a seam result; a duplicate becomes `other`. */
export function refusedAs<O>(r: Exclude<Metered<unknown>, { ok: true }>, other: O): Refused | O {
  if (r.reason === "no-credits")
    return { ok: false, error: "no-credits", balance: r.balance, need: r.need };
  if (r.reason === "paused") return { ok: false, error: "credits-paused" };
  return other;
}

/** Did the wallet refuse this seam result (no call made)? */
export const isRefused = (r: { ok: boolean; error?: string }): r is Refused =>
  !r.ok && (r.error === "no-credits" || r.error === "credits-paused");

/** The route's answer to a seam refusal. */
export const refusalOf = (r: Refused): Response =>
  r.error === "no-credits" ? noCreditsResponse(r) : pausedResponse();

/** The route's answer to a seam refusal, or null when `r` is something else. */
export function refusedResponse(r: { ok: boolean; error?: string }): Response | null {
  if (r.error === "no-credits")
    return noCreditsResponse(r as unknown as { balance: number; need: number });
  if (r.error === "credits-paused") return pausedResponse();
  return null;
}
