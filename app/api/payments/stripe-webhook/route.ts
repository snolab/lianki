import { NextResponse } from "next/server";
import { getD1 } from "@/lib/d1";
import { fulfilCheckout, type CheckoutSessionLike } from "@/lib/payments/fulfil";
import { stripeEnabled, verifyStripeSignature } from "@/lib/payments/stripe";
import { creditTopup } from "@/lib/payments/credits-store";
import { topupFromSession } from "@/lib/payments/providers/stripe";
import { rewardPurchase } from "@/lib/referrals/store";

/** Events that can mean a session is now paid; any other is acknowledged and ignored. */
const PAID_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

/**
 * Stripe's webhook for prepaid passes — pushed by Stripe, nothing polls.
 * Register https://lianki.com/api/payments/stripe-webhook in the Dashboard with
 * the two events above; its signing secret is STRIPE_WEBHOOK_SECRET.
 */
export async function POST(req: Request) {
  if (!stripeEnabled())
    return NextResponse.json({ error: "Payments are not enabled" }, { status: 503 });

  // The signature covers the exact bytes, so read the raw text before parsing.
  const body = await req.text();
  const ok = await verifyStripeSignature(
    body,
    req.headers.get("stripe-signature"),
    process.env.STRIPE_WEBHOOK_SECRET!.trim(),
  );
  if (!ok) return NextResponse.json({ error: "Bad signature" }, { status: 400 });

  const event = JSON.parse(body) as { type: string; data: { object: CheckoutSessionLike } };
  if (!PAID_EVENTS.has(event.type)) return NextResponse.json({ received: true });

  // A throw here is a 500, so Stripe retries; a duplicate or ignored session is a 200.
  const d1 = getD1() as never;

  // Credit-wallet top-ups ride the same endpoint (metadata.kind = "topup").
  if (event.data.object.metadata?.kind === "topup") {
    const t = topupFromSession(event.data.object);
    if (t.status !== "paid") {
      console.warn("[payments] top-up ignored", event.data.object.id, t);
      return NextResponse.json({ received: true, status: "ignored" });
    }
    const r = await creditTopup(d1, { ...t, provider: "stripe" });
    return NextResponse.json({ received: true, status: r.status });
  }

  const result = await fulfilCheckout(d1, event.data.object);
  // The inviter's purchase bonus. Also on a duplicate, so a failure here is
  // retried with the redelivery; it is once-only by itself.
  if (result.status !== "ignored") {
    const buyer = result.status === "applied" ? result.userId : event.data.object.metadata?.userId;
    if (buyer) {
      await rewardPurchase(d1, buyer).catch((e) => console.error("[payments] referral bonus:", e));
    }
  }
  if (result.status === "ignored")
    console.warn("[payments] ignored", event.data.object.id, result.reason);
  return NextResponse.json({ received: true, status: result.status });
}
