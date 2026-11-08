/**
 * The little of Stripe that passes need, over plain fetch and Web Crypto — no
 * SDK, so nothing Node-only reaches the Worker bundle.
 *
 * Mode is decided by the server's own settings, never by a request, and fails
 * closed (the same rule as KOMOJU). Two things decide it: the key's own prefix,
 * and the owner's `payments.stripe.live` feature flag (lib/flags.ts, toggled
 * at /dev/flags, no deploy):
 *
 * - **test**: an `sk_test_…` key and the flag off. Passes and top-ups are
 *   offered to the owner (`site_role`) only, and the webhook credits the
 *   owner only, kept apart from real money — a test card must never become
 *   real Pro days or credits for anyone.
 * - **live**: an `sk_live_…` key and the flag on. Offered to everyone.
 * - **off**: a secret is missing, the key disagrees with the flag (a live key
 *   with the flag off: no test mode on a live key), the flag cannot be read
 *   (it then reads as off), or the key has any other format (a restricted
 *   `rk_…` key included): the checkout route answers 503 and the membership
 *   page hides the buy buttons.
 *
 * Starting and settling differ on purpose. `stripeMode` (key + flag) decides
 * whether a payment may START. The webhook settles by `stripeKeyMode` (the key
 * alone): a signed event whose `livemode` matches a live key is real money
 * this server started while the flag was on — only the checkout route creates
 * sessions with our metadata, and only in live mode — so it is credited even if
 * the flag was turned off since (the kill switch stops new payments; it never
 * drops a customer's money). docs/payments.md, "Live mode and the kill switch".
 */
import { flagIn, type FlagValues } from "@/lib/flags";
import { isAdmin } from "@/lib/permissions";
import { stripeThreeDSecure } from "./checkout-policy";
import { topupName } from "./credits";
import type { CheckoutSessionLike } from "./fulfil";
import type { Pass } from "./passes";
import type { ProviderMode } from "./providers/types";

const API = "https://api.stripe.com/v1";

/** Payment methods offered on Checkout; each must be enabled in the Stripe Dashboard. */
const DEFAULT_METHODS = ["card", "alipay", "wechat_pay"];

type Env = Record<string, string | undefined>;

/**
 * What the configured key proves on its own: `sk_test_` → test, `sk_live_` →
 * live, with the webhook secret set; null otherwise. The webhook settles by
 * this (see the top of this file); starting a payment needs `stripeMode`.
 */
export function stripeKeyMode(env: Env = process.env): ProviderMode | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key || !env.STRIPE_WEBHOOK_SECRET?.trim()) return null;
  if (key.startsWith("sk_live_")) return "live";
  if (key.startsWith("sk_test_")) return "test";
  return null;
}

/**
 * Whether a Stripe payment may start, and in which mode: the key's prefix must
 * prove the mode AND agree with the `payments.stripe.live` flag; any other
 * combination is off rather than guessed. `flags` is a `readFlags()` snapshot;
 * a missing flag is off.
 */
export function stripeMode(env: Env = process.env, flags: FlagValues = {}): ProviderMode | null {
  const key = stripeKeyMode(env);
  const live = flagIn(flags, "payments.stripe.live");
  if (key === "live") return live ? "live" : null;
  if (key === "test") return live ? null : "test";
  return null;
}

export function stripeEnabled(env: Env = process.env, flags: FlagValues = {}): boolean {
  return stripeMode(env, flags) !== null;
}

/** Whether `email` may start a Stripe payment: live for everyone, test for the owner only. */
export function stripeOpenTo(
  email: string | null | undefined,
  env: Env = process.env,
  flags: FlagValues = {},
): boolean {
  const mode = stripeMode(env, flags);
  return mode === "live" || (mode === "test" && isAdmin(email));
}

function paymentMethods(): string[] {
  const v = process.env.STRIPE_PAYMENT_METHODS?.trim();
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_METHODS;
}

/** Flatten to Stripe's form encoding: `a[b][0]=c`. */
export function formEncode(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

/** What a checkout sells: a pass, or credits for the wallet (lib/payments/credits.ts). */
export type Purchase = { kind: "pass"; pass: Pass } | { kind: "topup"; amount: number };

export interface CheckoutInput {
  purchase: Purchase;
  userId: string;
  email?: string;
  successUrl: string;
  cancelUrl: string;
}

function lineFor(p: Purchase) {
  return p.kind === "pass"
    ? { currency: p.pass.currency, unit_amount: p.pass.amount, name: p.pass.name }
    : { currency: "jpy", unit_amount: p.amount, name: topupName(p.amount) };
}

/** Metadata the webhook reads back: who paid, and for what. */
function metadataFor(p: Purchase, userId: string): Record<string, string> {
  return p.kind === "pass"
    ? { userId, passId: p.pass.id }
    : { userId, kind: "topup", amount: String(p.amount) };
}

/**
 * How long a Checkout link stays payable: Stripe's minimum (30 min; its
 * default is 24 h). The live flag gates creating a session, not paying an
 * issued one, so a short life bounds how long a link from before the kill
 * switch can still be paid (docs/payments.md, "Live mode and the kill switch").
 */
export const CHECKOUT_EXPIRES_S = 30 * 60;

/** The Checkout Session parameters for a purchase (exported for tests). */
export function checkoutParams(
  { purchase, userId, email, successUrl, cancelUrl }: CheckoutInput,
  nowS = Math.floor(Date.now() / 1000),
) {
  const methods = paymentMethods();
  const line = lineFor(purchase);
  const metadata = metadataFor(purchase, userId);
  return {
    mode: "payment",
    // A minute over Stripe's minimum, so clock skew never makes it refuse.
    expires_at: nowS + CHECKOUT_EXPIRES_S + 60,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    customer_email: email,
    payment_method_types: methods,
    payment_method_options: {
      // 3-D Secure on every card payment (lib/payments/checkout-policy.ts).
      ...(methods.includes("card")
        ? { card: { request_three_d_secure: stripeThreeDSecure() } }
        : {}),
      // Checkout refuses WeChat Pay without naming the client it runs in.
      ...(methods.includes("wechat_pay") ? { wechat_pay: { client: "web" } } : {}),
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: line.currency,
          unit_amount: line.unit_amount,
          product_data: { name: line.name },
        },
      },
    ],
    metadata,
    payment_intent_data: { metadata },
  };
}

/**
 * Create a Checkout Session in `mode` — the `stripeMode` the caller decided
 * from its flag snapshot (so the gate and the session agree); returns its
 * hosted URL.
 */
export async function createCheckoutSession(
  input: CheckoutInput,
  mode: ProviderMode,
): Promise<string> {
  // The key itself must still be in that mode.
  if (stripeKeyMode() !== mode) throw new Error("Stripe is off");
  const res = await fetch(`${API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY!.trim()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode(checkoutParams(input)).join("&"),
  });
  const data = (await res.json()) as {
    url?: string;
    livemode?: boolean;
    error?: { message?: string };
  };
  if (!res.ok || !data.url) {
    throw new Error(`Stripe checkout failed (${res.status}): ${data.error?.message ?? "no url"}`);
  }
  // Belt and braces: Stripe says which mode the session is in; it must be ours.
  if (data.livemode !== (mode === "live")) throw new Error("Stripe session mode mismatch");
  return data.url;
}

// ── Webhook signature ───────────────────────────────────────────────────────────

/** How old a signed webhook may be; Stripe's own libraries use 5 minutes. */
const TOLERANCE_S = 300;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

/**
 * Verify a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=…]`) over the raw
 * body: HMAC-SHA256 of `${t}.${body}` with the endpoint secret, within the
 * tolerance window so a captured request cannot be replayed later.
 */
export async function verifyStripeSignature(
  body: string,
  header: string | null,
  secret: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") t = v ?? "";
    else if (k === "v1" && v) sigs.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || sigs.length === 0) return false;
  if (Math.abs(nowS - ts) > TOLERANCE_S) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

/** Events that can mean a session is now paid; any other is acknowledged and ignored. */
export const PAID_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

export interface StripeEvent {
  type?: string;
  livemode?: boolean;
  data?: { object?: CheckoutSessionLike };
}

/** Verify a delivery and parse it; null when the signature or body is bad. */
export async function readStripeEvent(req: Request): Promise<StripeEvent | null> {
  // The signature covers the exact bytes, so read the raw text before parsing.
  const body = await req.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return null;
  if (!(await verifyStripeSignature(body, req.headers.get("stripe-signature"), secret)))
    return null;
  try {
    const event = JSON.parse(body) as StripeEvent;
    return event && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}
