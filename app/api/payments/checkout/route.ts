import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend } from "@/lib/d1";
import { passFor } from "@/lib/payments/passes";
import { createCheckoutSession, stripeEnabled } from "@/lib/payments/stripe";

/** Whether passes are on sale — the membership page asks before showing buy buttons. */
export async function GET() {
  return NextResponse.json({ enabled: stripeEnabled() && dbBackend() === "d1" });
}

/** Start a Stripe Checkout for a prepaid pass: `{ passId }` → `{ url }` to redirect to. */
export async function POST(req: Request) {
  // Fulfilment writes D1 only; the Mongo copy is a frozen rollback.
  if (!stripeEnabled() || dbBackend() !== "d1") {
    return NextResponse.json({ error: "Payments are not enabled" }, { status: 503 });
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { passId?: unknown } | null;
  const pass = passFor(body?.passId);
  if (!pass) return NextResponse.json({ error: "Unknown pass" }, { status: 400 });

  const origin = new URL(req.url).origin;
  try {
    const url = await createCheckoutSession({
      pass,
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
