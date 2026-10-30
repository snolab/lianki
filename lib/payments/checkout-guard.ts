/**
 * Card-testing ("credit master") protection on checkout start, provider
 * agnostic — runs before any payment provider is called:
 *
 * 1. a rate limit: 5 checkout starts per 10 minutes, per user and per IP
 *    (counted whether or not the attempt then passes, so failing tokens
 *    count too);
 * 2. Cloudflare Turnstile: a token from the membership page's widget,
 *    verified server-side with TURNSTILE_SECRET_KEY.
 *
 * Production fails closed: without TURNSTILE_SECRET_KEY checkout answers 503
 * rather than run unprotected. In dev/test the check is skipped when unset.
 * 3-D Secure, the third measure, is set on the provider request itself
 * (lib/payments/checkout-policy.ts).
 */
import { CHECKOUT_STARTS, hit, ipKey, type ThrottleDb } from "@/lib/security/throttle";

export type GuardResult =
  | { ok: true }
  | { ok: false; status: 429 | 403 | 503; error: string; retryAfterS?: number };

export async function guardCheckout(
  db: ThrottleDb,
  a: {
    userId: string;
    ip: string;
    turnstileToken: unknown;
    /** TURNSTILE_SECRET_KEY is set. */
    turnstileConfigured: boolean;
    production: boolean;
    verifyTurnstile: (token: string) => Promise<boolean>;
    now?: number;
  },
): Promise<GuardResult> {
  const now = a.now ?? Date.now();
  const results = [await hit(db, `checkout:user:${a.userId}`, CHECKOUT_STARTS, now)];
  if (a.ip && a.ip !== "unknown")
    results.push(await hit(db, ipKey("checkout", a.ip), CHECKOUT_STARTS, now));
  const refused = results.filter((r) => !r.allowed);
  if (refused.length) {
    return {
      ok: false,
      status: 429,
      error: "Too many checkout attempts",
      retryAfterS: Math.ceil(Math.max(...refused.map((r) => r.retryAfterMs)) / 1000),
    };
  }

  if (!a.turnstileConfigured) {
    return a.production
      ? { ok: false, status: 503, error: "Bot protection is not configured" }
      : { ok: true };
  }
  const token = typeof a.turnstileToken === "string" ? a.turnstileToken : "";
  if (!token || !(await a.verifyTurnstile(token).catch(() => false))) {
    return { ok: false, status: 403, error: "captcha" };
  }
  return { ok: true };
}
