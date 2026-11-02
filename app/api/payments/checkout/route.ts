import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { runtimeNodeEnv } from "@/lib/auth-env";
import { guardCheckout } from "@/lib/payments/checkout-guard";
import { clientIp, type ThrottleDb } from "@/lib/security/throttle";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { passFor } from "@/lib/payments/passes";
import { createCheckoutSession, stripeEnabled } from "@/lib/payments/stripe";

/** Whether passes are on sale — the membership page asks before showing buy buttons. */
export async function GET() {
  return NextResponse.json({ enabled: stripeEnabled() && dbBackend() === "d1" });
}

/**
 * Start a Stripe Checkout for a prepaid pass: `{ passId, turnstileToken }` →
 * `{ url }` to redirect to. Rate limit + Turnstile first (checkout-guard.ts);
 * the session itself asks for 3-D Secure (checkout-policy.ts).
 */
export async function POST(req: Request) {
  // Fulfilment writes D1 only; the Mongo copy is a frozen rollback.
  if (!stripeEnabled() || dbBackend() !== "d1") {
    return NextResponse.json({ error: "Payments are not enabled" }, { status: 503 });
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    passId?: unknown;
    turnstileToken?: unknown;
  } | null;
  const pass = passFor(body?.passId);
  if (!pass) return NextResponse.json({ error: "Unknown pass" }, { status: 400 });

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
    const url = await createCheckoutSession({
      purchase: { kind: "pass", pass },
      userId: session.user.id,
      email: session.user.email,
      successUrl: `${origin}/membership?paid=1`,
      cancelUrl: `${origin}/membership`,
    });
    return NextResponse.json({ url });
  } catch (error) {
    console.error("[payments] checkout:", error);
    return NextResponse.json({ error: "Could not start checkout" }, { status: 502 });
  }
}
