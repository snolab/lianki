/**
 * Stripe — the first credit-wallet provider (card, Alipay, WeChat Pay via
 * Checkout). Top-ups are Checkout Sessions with `metadata.kind = "topup"`;
 * they arrive on the same /api/payments/stripe-webhook as passes
 * (lib/payments/stripe-webhook.ts), which hands them to `topupFromSession`.
 * Test or live by `stripeMode` (lib/payments/stripe.ts): test mode is the
 * owner's alone, on this provider route as on the pass route.
 */
import { createCheckoutSession, PAID_EVENTS, readStripeEvent, stripeMode } from "../stripe";
import type { CheckoutSessionLike } from "../fulfil";
import type { PaymentProvider, WebhookOutcome } from "./types";

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
  mode: stripeMode,
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
    const mode = stripeMode();
    if (!mode) return { status: "invalid" };
    const event = await readStripeEvent(req);
    // Signed, but for the other mode: the secrets are mixed up — credit nothing.
    if (!event || event.livemode !== (mode === "live")) return { status: "invalid" };
    const type = String(event.type ?? "");
    if (!PAID_EVENTS.has(type) || !event.data?.object)
      return { status: "ignored", reason: type || "no type" };
    return topupFromSession(event.data.object);
  },
};
