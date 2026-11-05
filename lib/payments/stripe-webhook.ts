/**
 * What /api/payments/stripe-webhook does with a delivery, apart from the HTTP
 * glue (so it is unit-tested end to end over the test D1):
 *
 * - Stripe off (`stripeKeyMode` null: a secret missing, or a key that does not
 *   prove its mode) → 503. The `payments.stripe.live` flag is NOT checked
 *   here: it gates starting a payment, and a live session can only have been
 *   started while it was on, so a genuinely live event is credited even after
 *   the flag was turned off (the kill switch never drops paid money —
 *   docs/payments.md, "Live mode and the kill switch");
 * - a bad signature or a body that is not JSON → 400;
 * - an event whose `livemode` disagrees with our mode → 503 and an error log:
 *   the secrets are mixed up, so nothing is credited, and Stripe keeps
 *   retrying (for 3 days) until the owner fixes them;
 * - a paid session → a pass (`fulfil.ts`) or a top-up (`metadata.kind =
 *   "topup"`, the credit ledger), once per session.
 *
 * Test mode credits the owner's account only — anyone else's session is
 * acknowledged and ignored — and keeps it apart from real money: a pass's
 * `payment` row gets `testMode = 1` and earns no inviter bonus (that would be
 * real Pro days for someone else); a top-up goes to `credit_test_ledger`
 * (`creditTestTopup`), never to the spendable balance, so test credits can buy
 * nothing and never become real credits, even after a switch to live.
 */
import { isOwner } from "@/lib/owner";
import { refreshOwners } from "@/lib/owner-store";
import type { OwnerReadDb } from "@/lib/site-role";
import { rewardPurchase } from "@/lib/referrals/store";
import { creditTestTopup, creditTopup, type D1WithBatch } from "./credits-store";
import { fulfilCheckout } from "./fulfil";
import { topupFromSession } from "./providers/stripe";
import { PAID_EVENTS, readStripeEvent, stripeKeyMode } from "./stripe";
import type { WebhookReply } from "./webhook";

async function emailOf(d1: D1WithBatch, userId: string): Promise<string | null> {
  const row = await d1
    .prepare("SELECT email FROM user WHERE id = ?")
    .bind(userId)
    .first<{ email: string | null }>();
  return row?.email ?? null;
}

export async function handleStripeWebhook(
  d1: D1WithBatch,
  req: Request,
  now = new Date(),
): Promise<WebhookReply> {
  const mode = stripeKeyMode();
  if (!mode) return { status: 503, body: { error: "Payments are not enabled" } };

  const event = await readStripeEvent(req);
  if (!event) return { status: 400, body: { error: "Bad signature" } };
  if (event.livemode !== (mode === "live")) {
    console.error(
      JSON.stringify({ event: "payments.stripe.mode-mismatch", mode, livemode: event.livemode }),
    );
    return { status: 503, body: { error: "Mode mismatch" } };
  }
  const session = event.data?.object;
  if (!PAID_EVENTS.has(String(event.type)) || !session?.id)
    return { status: 200, body: { received: true } };

  const testMode = mode === "test";
  if (testMode) {
    const userId = session.metadata?.userId || session.client_reference_id;
    await refreshOwners(() => d1 as unknown as OwnerReadDb); // a webhook has no session
    if (!userId || !isOwner(await emailOf(d1, userId))) {
      console.warn(JSON.stringify({ event: "payments.stripe.test-ignored", session: session.id }));
      return { status: 200, body: { received: true, status: "ignored" } };
    }
  }

  // Credit-wallet top-ups ride the same endpoint (metadata.kind = "topup").
  if (session.metadata?.kind === "topup") {
    const t = topupFromSession(session);
    if (t.status !== "paid") {
      console.warn("[payments] top-up ignored", session.id, t);
      return { status: 200, body: { received: true, status: "ignored" } };
    }
    // Test credits go to the separate test ledger: never spendable, never real.
    const r = testMode
      ? await creditTestTopup(d1, { ...t, provider: "stripe" }, now)
      : await creditTopup(d1, { ...t, provider: "stripe" }, now);
    return { status: 200, body: { received: true, status: r.status } };
  }

  // A throw here is a 500, so Stripe retries; a duplicate or ignored session is a 200.
  const result = await fulfilCheckout(d1, session, now, { testMode });
  // The inviter's purchase bonus — real money only. Also on a duplicate, so a
  // failure here is retried with the redelivery; it is once-only by itself.
  if (result.status !== "ignored" && !testMode) {
    const buyer = result.status === "applied" ? result.userId : session.metadata?.userId;
    if (buyer) {
      try {
        await rewardPurchase(d1, buyer);
      } catch (e) {
        console.error("[payments] referral bonus:", e);
      }
    }
  }
  if (result.status === "ignored") console.warn("[payments] ignored", session.id, result.reason);
  return { status: 200, body: { received: true, status: result.status } };
}
