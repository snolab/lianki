import { NextResponse } from "next/server";
import { getD1 } from "@/lib/d1";
import { fulfilCheckout, type CheckoutSessionLike } from "@/lib/payments/fulfil";
import { stripeEnabled, verifyStripeSignature } from "@/lib/payments/stripe";

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
  const result = await fulfilCheckout(getD1() as never, event.data.object);
  if (result.status === "ignored")
    console.warn("[payments] ignored", event.data.object.id, result.reason);
  return NextResponse.json({ received: true, status: result.status });
}
