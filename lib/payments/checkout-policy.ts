/**
 * What every payment provider integration must do on checkout, whichever
 * provider takes the card (Stripe today; PAY.JP is planned). The provider
 * adapters read this instead of choosing for themselves, and unit tests
 * assert each adapter's request carries it. docs/security-measures.md.
 *
 * - **3-D Secure on every card payment** (EMV 3-D Secure, required of Japanese
 *   EC merchants since 2025-03 and by the PAY.JP security declaration). The
 *   card network decides frictionless vs. challenge; Lianki always asks for it.
 * - **Bot check + rate limit before the provider is called**
 *   (lib/payments/checkout-guard.ts): card-testing protection.
 */
export const CHECKOUT_POLICY = {
  threeDSecure: "required",
} as const;

export type ThreeDSecurePolicy = (typeof CHECKOUT_POLICY)["threeDSecure"];

/**
 * Stripe's form of it: `payment_method_options.card.request_three_d_secure`.
 * "any" makes Checkout run 3DS authentication whenever the card supports it
 * (Stripe's strongest setting for a hosted Checkout Session).
 */
export function stripeThreeDSecure(policy: ThreeDSecurePolicy = CHECKOUT_POLICY.threeDSecure) {
  return policy === "required" ? "any" : "automatic";
}

/**
 * PAY.JP's form, for the adapter that does not exist yet: charges are created
 * with `three_d_secure=true` (PAY.JP API "3Dセキュア"), and a charge that comes
 * back without a successful 3DS result must not be captured or fulfilled.
 */
export function payjpThreeDSecure(policy: ThreeDSecurePolicy = CHECKOUT_POLICY.threeDSecure) {
  return { three_d_secure: policy === "required" };
}
