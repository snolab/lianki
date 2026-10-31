import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { runtimeNodeEnv } from "@/lib/auth-env";
import { guardCheckout } from "@/lib/payments/checkout-guard";
import { topupAmount, TOPUP_MAX, TOPUP_MIN } from "@/lib/payments/credits";
import { enabledProviders, providerFor, providerEnabled } from "@/lib/payments/providers";
import { clientIp, type ThrottleDb } from "@/lib/security/throttle";
import { verifyTurnstileToken } from "@/lib/turnstile";

/**
 * Start a credit top-up: `{ amount, provider?, turnstileToken }` →
 * `{ kind: "redirect", url }` or `{ kind: "qr", qr }`. Same card-testing guard
 * as pass checkout (rate limit + Turnstile, checkout-guard.ts). The wallet is
 * credited by the provider's webhook, not here.
 */
export async function POST(req: Request) {
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "Payments are not enabled" }, { status: 503 });
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    amount?: unknown;
    provider?: unknown;
    turnstileToken?: unknown;
  } | null;
  const amount = topupAmount(body?.amount);
  if (amount === null) {
    return NextResponse.json(
      { error: `amount must be a whole number of yen, ${TOPUP_MIN}–${TOPUP_MAX}` },
      { status: 400 },
    );
  }
  const checkout = enabledProviders().filter((p) => p.kind === "checkout");
  const provider = body?.provider == null ? checkout[0] : providerFor(body.provider);
  if (!provider || !providerEnabled(provider) || !provider.createTopup) {
    return NextResponse.json({ error: "Payments are not enabled" }, { status: 503 });
  }

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
    console.log(JSON.stringify({ event: "topup.refused", status: guard.status }));
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
    const start = await provider.createTopup(
      amount,
      { id: session.user.id, email: session.user.email },
      { successUrl: `${origin}/membership?topup=1`, cancelUrl: `${origin}/membership` },
    );
    return NextResponse.json(start);
  } catch (error) {
    console.error(`[payments] topup via ${provider.id}:`, error);
    return NextResponse.json({ error: "Could not start checkout" }, { status: 502 });
  }
}
