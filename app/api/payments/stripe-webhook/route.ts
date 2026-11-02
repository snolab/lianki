import { NextResponse } from "next/server";
import { getD1 } from "@/lib/d1";
import type { D1WithBatch } from "@/lib/payments/credits-store";
import { handleStripeWebhook } from "@/lib/payments/stripe-webhook";

/**
 * Stripe's webhook for prepaid passes and credit top-ups — pushed by Stripe,
 * nothing polls. Register https://lianki.com/api/payments/stripe-webhook in the
 * Dashboard with checkout.session.completed and
 * checkout.session.async_payment_succeeded; its signing secret is
 * STRIPE_WEBHOOK_SECRET. Test/live mode and everything else:
 * lib/payments/stripe-webhook.ts.
 */
export async function POST(req: Request) {
  // A throw is a 500, so Stripe retries.
  const r = await handleStripeWebhook(getD1() as unknown as D1WithBatch, req);
  return NextResponse.json(r.body, { status: r.status });
}
