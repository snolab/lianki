import { NextResponse } from "next/server";
import { dbBackend, getD1 } from "@/lib/d1";
import { type D1WithBatch } from "@/lib/payments/credits-store";
import { handleProviderWebhook } from "@/lib/payments/webhook";
import { providerFor } from "@/lib/payments/providers";

/**
 * One webhook endpoint per credit provider: /api/payments/webhook/<id>. The
 * provider verifies its own signature and reads the payment; every provider
 * then credits the same ledger, keyed by `<provider>:<paymentId>`, so a
 * redelivery is a no-op (lib/payments/webhook.ts). (Stripe also accepts
 * top-ups on its older /api/payments/stripe-webhook, which handles passes too.)
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const provider = providerFor((await ctx.params).provider);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  if (dbBackend() !== "d1") return NextResponse.json({ error: "Not enabled" }, { status: 503 });
  // A throw is a 500, so the provider retries.
  const r = await handleProviderWebhook(getD1() as unknown as D1WithBatch, provider, req);
  return NextResponse.json(r.body, { status: r.status });
}
