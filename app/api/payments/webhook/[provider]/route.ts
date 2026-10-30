import { NextResponse } from "next/server";
import { dbBackend, getD1 } from "@/lib/d1";
import { creditTopup, type D1WithBatch } from "@/lib/payments/credits-store";
import { providerEnabled, providerFor } from "@/lib/payments/providers";

/**
 * One webhook endpoint per credit provider: /api/payments/webhook/<id>. The
 * provider verifies its own signature and reads the payment; every provider
 * then credits the same ledger, keyed by `<provider>:<paymentId>`, so a
 * redelivery is a no-op. (Stripe also accepts top-ups on its older
 * /api/payments/stripe-webhook, which handles passes too.)
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const provider = providerFor((await ctx.params).provider);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  if (!providerEnabled(provider) || dbBackend() !== "d1")
    return NextResponse.json({ error: "Not enabled" }, { status: 503 });

  const out = await provider.verifyWebhook(req);
  if (out.status === "invalid")
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  if (out.status === "ignored") return NextResponse.json({ received: true, status: "ignored" });
  // A throw is a 500, so the provider retries.
  const r = await creditTopup(getD1() as unknown as D1WithBatch, {
    userId: out.userId,
    amount: out.amount,
    provider: provider.id,
    paymentId: out.paymentId,
    reason: provider.kind === "grant" ? "sponsor" : "topup",
  });
  if (r.status === "no user") console.warn("[payments] credit for unknown user", provider.id);
  return NextResponse.json({ received: true, status: r.status });
}
