/**
 * The little of Stripe that passes need, over plain fetch and Web Crypto — no
 * SDK, so nothing Node-only reaches the Worker bundle.
 *
 * Off unless STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are both set: the
 * checkout route answers 503 and the membership page hides the buy buttons.
 */
import { stripeThreeDSecure } from "./checkout-policy";
import type { Pass } from "./passes";

const API = "https://api.stripe.com/v1";

/** Payment methods offered on Checkout; each must be enabled in the Stripe Dashboard. */
const DEFAULT_METHODS = ["card", "alipay", "wechat_pay"];

export function stripeEnabled(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_WEBHOOK_SECRET?.trim(),
  );
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

export interface CheckoutInput {
  pass: Pass;
  userId: string;
  email?: string;
  successUrl: string;
  cancelUrl: string;
}

/** The Checkout Session parameters for a pass (exported for tests). */
export function checkoutParams({ pass, userId, email, successUrl, cancelUrl }: CheckoutInput) {
  const methods = paymentMethods();
  return {
    mode: "payment",
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
          currency: pass.currency,
          unit_amount: pass.amount,
          product_data: { name: pass.name },
        },
      },
    ],
    metadata: { userId, passId: pass.id },
    payment_intent_data: { metadata: { userId, passId: pass.id } },
  };
}

/** Create a Checkout Session; returns its hosted URL. */
export async function createCheckoutSession(input: CheckoutInput): Promise<string> {
  const res = await fetch(`${API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY!.trim()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode(checkoutParams(input)).join("&"),
  });
  const data = (await res.json()) as { url?: string; error?: { message?: string } };
  if (!res.ok || !data.url) {
    throw new Error(`Stripe checkout failed (${res.status}): ${data.error?.message ?? "no url"}`);
  }
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
