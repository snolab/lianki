import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { runtimeNodeEnv } from "@/lib/auth-env";
import { guardCheckout } from "@/lib/payments/checkout-guard";
import { clientIp, type ThrottleDb } from "@/lib/security/throttle";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { passFor } from "@/lib/payments/passes";
import { createCheckoutSession, stripeMode, stripeOpenTo } from "@/lib/payments/stripe";
import { readFlags } from "@/lib/flags-store";

/**
 * Whether passes are on sale to this visitor — the membership page asks before
 * showing buy buttons. In Stripe test mode only the owner sees them; live
 * needs a live key and the `payments.stripe.live` flag (lib/flags.ts).
 */
export async function GET() {
  if (dbBackend() !== "d1") return NextResponse.json({ enabled: false });
  const flags = await readFlags();
  const mode = stripeMode(process.env, flags);
  if (!mode) return NextResponse.json({ enabled: false });
  const session = await auth.api.getSession({ headers: await headers() });
  const enabled = stripeOpenTo(session?.user?.email, process.env, flags);
  return NextResponse.json({ enabled, test: enabled && mode === "test" });
}

/**
 * Start a Stripe Checkout for a prepaid pass: `{ passId, turnstileToken }` →
 * `{ url }` to redirect to. Rate limit + Turnstile first (checkout-guard.ts);
 * the session itself asks for 3-D Secure (checkout-policy.ts).
 */
export async function POST(req: Request) {
  // Fulfilment writes D1 only; the Mongo copy is a frozen rollback.
  if (dbBackend() !== "d1") {
    return NextResponse.json({ error: "payments-off" }, { status: 503 });
  }
  // One flag snapshot for the gate and the session (fail closed: unreadable = off).
  const flags = await readFlags();
  const mode = stripeMode(process.env, flags);
  if (!mode) return NextResponse.json({ error: "payments-off" }, { status: 503 });
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "login-required" }, { status: 401 });
  // Test mode is the owner's alone; to anyone else Stripe is simply off.
  if (!stripeOpenTo(session.user.email, process.env, flags)) {
    return NextResponse.json({ error: "payments-off" }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as {
    passId?: unknown;
    turnstileToken?: unknown;
  } | null;
  const pass = passFor(body?.passId);
  if (!pass) return NextResponse.json({ error: "unknown-pass" }, { status: 400 });

  const env = runtimeNodeEnv();
  const guard = await guardCheckout(getD1() as unknown as ThrottleDb, {
    userId: session.user.id,
    ip: clientIp(req.headers),
    turnstileToken: body?.turnstileToken,
    turnstileConfigured: Boolean(process.env.TURNSTILE_SECRET_KEY?.trim()),
    production: env !== "development" && env !== "test",
    verifyTurnstile: verifyTurnstileToken,
  });
  if (!guard.ok) {
    console.log(JSON.stringify({ event: "checkout.refused", status: guard.status }));
    return NextResponse.json(
      { error: guard.error },
      {
        status: guard.status,
        headers: guard.retryAfterS ? { "Retry-After": String(guard.retryAfterS) } : undefined,
      },
    );
  }

  const origin = new URL(req.url).origin;
  try {
    const url = await createCheckoutSession(
      {
        purchase: { kind: "pass", pass },
        userId: session.user.id,
        email: session.user.email,
        successUrl: `${origin}/membership?paid=1`,
        cancelUrl: `${origin}/membership`,
      },
      mode,
    );
    return NextResponse.json({ url });
  } catch (error) {
    console.error("[payments] checkout:", error);
    return NextResponse.json({ error: "checkout-failed" }, { status: 502 });
  }
}
