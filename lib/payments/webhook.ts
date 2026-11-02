/**
 * What /api/payments/webhook/<provider> does with a delivery, apart from the
 * HTTP glue (so it is unit-tested end to end over the test D1):
 *
 * - off (secrets missing, or a key that contradicts its mode) → 503;
 * - a bad signature → 400;
 * - `paid` → credit `<provider>:<paymentId>` once (a redelivery is a no-op).
 *   In test mode only the owner's account is credited; anyone else's is
 *   ignored, so a test card never turns into real credits;
 * - `refunded` → take the top-up back once; if the credits were already spent
 *   it is logged for the owner (the balance never goes negative) and answered
 *   200, since a retry cannot fix it.
 */
import { isOwner } from "@/lib/owner";
import { creditTopup, reverseTopup, type D1WithBatch } from "./credits-store";
import { providerMode, type PaymentProvider } from "./providers";

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
}

async function emailOf(d1: D1WithBatch, userId: string): Promise<string | null> {
  const row = await d1
    .prepare("SELECT email FROM user WHERE id = ?")
    .bind(userId)
    .first<{ email: string | null }>();
  return row?.email ?? null;
}

export async function handleProviderWebhook(
  d1: D1WithBatch,
  provider: PaymentProvider,
  req: Request,
  now = new Date(),
): Promise<WebhookReply> {
  const mode = providerMode(provider);
  if (!mode) return { status: 503, body: { error: "Not enabled" } };

  const out = await provider.verifyWebhook(req);
  if (out.status === "invalid") return { status: 400, body: { error: "Bad signature" } };
  if (out.status === "ignored") {
    console.log(
      JSON.stringify({
        event: "credits.webhook.ignored",
        provider: provider.id,
        reason: out.reason,
      }),
    );
    return { status: 200, body: { received: true, status: "ignored" } };
  }

  const refId = `${provider.id}:${out.paymentId}`;
  if (out.status === "refunded") {
    const r = await reverseTopup(d1, refId, now, "refunded at the provider");
    if (r.status === "insufficient" || r.status === "not found")
      console.error(
        JSON.stringify({
          event: "credits.refund.unsettled",
          provider: provider.id,
          refId,
          status: r.status,
        }),
      );
    return { status: 200, body: { received: true, status: r.status } };
  }

  if (mode === "test" && !isOwner(await emailOf(d1, out.userId))) {
    console.warn(
      JSON.stringify({ event: "credits.webhook.test-ignored", provider: provider.id, refId }),
    );
    return { status: 200, body: { received: true, status: "ignored" } };
  }
  const r = await creditTopup(
    d1,
    {
      userId: out.userId,
      amount: out.amount,
      provider: provider.id,
      paymentId: out.paymentId,
      reason: provider.kind === "grant" ? "sponsor" : "topup",
      note: mode === "test" ? "test mode" : undefined,
    },
    now,
  );
  if (r.status === "no user") console.warn("[payments] credit for unknown user", provider.id);
  return { status: 200, body: { received: true, status: r.status } };
}
