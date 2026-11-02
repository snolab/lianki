/**
 * Stripe — the first credit-wallet provider (card, Alipay, WeChat Pay via
 * Checkout). Top-ups are Checkout Sessions with `metadata.kind = "topup"`;
 * they arrive on the same /api/payments/stripe-webhook as passes, which hands
 * them to `topupFromSession`.
 */
import { createCheckoutSession, stripeEnabled, verifyStripeSignature } from "../stripe";
import type { CheckoutSessionLike } from "../fulfil";
import type { PaymentProvider, WebhookOutcome } from "./types";

const PAID_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

/** A paid top-up session → what to credit; anything else is not a top-up. */
export function topupFromSession(s: CheckoutSessionLike): WebhookOutcome {
  if (s.metadata?.kind !== "topup") return { status: "ignored", reason: "not a top-up" };
  if (s.payment_status !== "paid") return { status: "ignored", reason: "not paid" };
  if ((s.currency ?? "jpy").toLowerCase() !== "jpy")
    return { status: "ignored", reason: "not JPY" };
  const userId = s.metadata?.userId || s.client_reference_id;
  if (!userId) return { status: "ignored", reason: "no user" };
  // Credit what was actually paid, not what the metadata asked for.
  const amount = Number(s.amount_total);
  if (!Number.isInteger(amount) || amount <= 0) return { status: "ignored", reason: "no amount" };
  return { status: "paid", paymentId: s.id, amount, userId };
}

export const stripeProvider: PaymentProvider = {
  id: "stripe",
  label: "Stripe",
  methods: ["Card", "Alipay", "WeChat Pay"],
  kind: "checkout",
  envKeys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  implemented: true,
  async createTopup(amount, user, urls) {
    const url = await createCheckoutSession({
      purchase: { kind: "topup", amount },
      userId: user.id,
      email: user.email,
      ...urls,
    });
    return { kind: "redirect", url };
  },
  async verifyWebhook(req) {
    if (!stripeEnabled()) return { status: "invalid" };
    const body = await req.text();
    const ok = await verifyStripeSignature(
      body,
      req.headers.get("stripe-signature"),
      process.env.STRIPE_WEBHOOK_SECRET!.trim(),
    );
    if (!ok) return { status: "invalid" };
    const event = JSON.parse(body) as { type: string; data: { object: CheckoutSessionLike } };
    if (!PAID_EVENTS.has(event.type)) return { status: "ignored", reason: event.type };
    return topupFromSession(event.data.object);
  },
};
