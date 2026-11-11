import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { runtimeNodeEnv } from "@/lib/auth-env";
import { guardCheckout } from "@/lib/payments/checkout-guard";
import { topupAmount, TOPUP_MAX, TOPUP_MIN } from "@/lib/payments/credits";
import { readFlags } from "@/lib/flags-store";
import { providerFor, providerMode, providerOpenTo, providersFor } from "@/lib/payments/providers";
import { clientIp, type ThrottleDb } from "@/lib/security/throttle";
import { verifyTurnstileToken } from "@/lib/turnstile";

/**
 * Start a credit top-up: `{ amount, provider?, turnstileToken }` →
 * `{ kind: "redirect", url }` or `{ kind: "qr", qr }`. Same card-testing guard
 * as pass checkout (rate limit + Turnstile, checkout-guard.ts). The wallet is
 * credited by the provider's webhook, not here.
 */
export async function POST(req: Request) {
  if (dbBackend() !== "d1") return NextResponse.json({ error: "payments-off" }, { status: 503 });
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "login-required" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    amount?: unknown;
    provider?: unknown;
    turnstileToken?: unknown;
  } | null;
  const amount = topupAmount(body?.amount);
  if (amount === null) {
    return NextResponse.json({ error: "invalid-amount" }, { status: 400 });
  }
  // Only a provider open to this user: a test-mode one is the owner's alone,
  // a live one needs its live flag on. One flag snapshot for the gate and the
  // session (fail closed: unreadable = off).
  const flags = await readFlags();
  const checkout = providersFor(session.user.email, process.env, flags).filter(
    (p) => p.kind === "checkout",
  );
  const provider = body?.provider == null ? checkout[0] : providerFor(body.provider);
  const mode = provider ? providerMode(provider, process.env, flags) : null;
  if (
    !provider ||
    !mode ||
    !providerOpenTo(provider, session.user.email, process.env, flags) ||
    !provider.createTopup
  ) {
    return NextResponse.json({ error: "payments-off" }, { status: 503 });
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
      mode,
    );
    return NextResponse.json(start);
  } catch (error) {
    console.error(`[payments] topup via ${provider.id}:`, error);
    return NextResponse.json({ error: "checkout-failed" }, { status: 502 });
  }
}
