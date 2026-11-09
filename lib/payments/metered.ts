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
import type { Feature } from "./prices";

/** No paid call lasts near this long: a hold older than this is a crashed call's. */
export const HOLD_STALE_MS = 10 * 60_000;

export type Payer = { userId: string; email?: string | null };

export type Metered<T> =
  | { ok: true; value: T; charged: number; free?: "admin" | "unmetered" }
  | { ok: false; reason: "no-credits"; balance: number; need: number }
  | { ok: false; reason: "duplicate" };

export type MeterDeps = {
  d1: D1WithBatch | null;
  now?: () => Date;
  log?: (o: Record<string, unknown>) => void;
  /** Is this payer an admin? Defaults to the permission snapshot. */
  admin?: (email: string | null | undefined) => boolean;
};

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
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((o) => console.log(JSON.stringify(o)));
  const admin = deps.admin ?? isAdmin;
  if (admin(payer.email)) {
    const r = await run();
    log({ event: "credits.free", what: call.what, why: "admin", usd: r.usd });
    return { ok: true, value: r.value, charged: 0, free: "admin" };
  }
  if (!deps.d1) {
    const r = await run();
    log({ event: "credits.unmetered", what: call.what, usd: r.usd });
    return { ok: true, value: r.value, charged: 0, free: "unmetered" };
  }
  const d1 = deps.d1;
  try {
    await sweepStaleAi(d1, HOLD_STALE_MS, now());
  } catch {}
  const key = `${call.what}:${payer.userId}:${call.key ?? crypto.randomUUID()}`;
  const need = reserveCredits(call.holdUsd);
  const hold = await reserveAi(
    d1,
    { userId: payer.userId, key, reserved: need, what: call.what },
    now(),
  );
  if (hold.status === "duplicate") return { ok: false, reason: "duplicate" };
  if (hold.status !== "reserved")
    return {
      ok: false,
      reason: "no-credits",
      balance: hold.status === "insufficient" ? hold.balance : 0,
      need,
    };

  let costMicro = 0;
  try {
    const r = await run();
    costMicro = usdToMicroCredits(r.usd);
    const capMicro = usdToMicroCredits(call.holdUsd);
    if (costMicro > capMicro) {
      log({ event: "credits.overage", what: call.what, usd: r.usd, holdUsd: call.holdUsd });
      costMicro = capMicro;
    }
    const settled = await settleSafe(d1, key, costMicro, now());
    return { ok: true, value: r.value, charged: settled?.charged ?? 0 };
  } catch (err) {
    // The provider failed: nothing kept. A failed settle leaves the hold pending
    // for the next request's sweep, which also refunds it in full.
    await settleSafe(d1, key, 0, now());
    throw err;
  }
}

async function settleSafe(d1: D1WithBatch, key: string, micro: number, at: Date) {
  try {
    return await settleAi(d1, key, micro, at);
  } catch {
    return null;
  }
}

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
  r.reason === "no-credits" ? noCreditsResponse(r) : duplicateResponse();
