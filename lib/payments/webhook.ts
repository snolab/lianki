/**
 * What /api/payments/webhook/<provider> does with a delivery, apart from the
 * HTTP glue (so it is unit-tested end to end over the test D1):
 *
 * - off (secrets missing, or a key that does not prove its mode) → 503. The
 *   live feature flag is not checked here — it gates starting a payment, and
 *   a payment started while it was on is credited after it is turned off
 *   (`providerSettleMode`; docs/payments.md, "Live mode and the kill switch");
 * - a bad signature → 400;
 * - `paid` → credit `<provider>:<paymentId>` once (a redelivery is a no-op).
 *   In test mode only the owner's account is credited; anyone else's is
 *   ignored, and the owner's goes to the separate test ledger
 *   (`creditTestTopup`), which nothing can spend and which never becomes real
 *   balance — so a test card never turns into real credits or real Pro;
 * - `refunded` → take the top-up back once, and mark the payment so a capture
 *   still in flight can never credit it afterwards; if the credits were already spent
 *   it is logged for the owner (the balance never goes negative) and answered
 *   200, since a retry cannot fix it.
 */
import { isAdmin } from "@/lib/permissions";
import { refreshOwnersFrom } from "@/lib/owner-store";
import { refreshPermissionsFrom } from "@/lib/permission-store";
import {
  creditTestTopup,
  creditTopup,
  refundProviderTopup,
  refundTestTopup,
  type D1WithBatch,
} from "./credits-store";
import { providerSettleMode, type PaymentProvider } from "./providers";

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
}

/** A webhook has no session, so it refreshes the owner list itself (lib/owner-store.ts). */
async function ownerAccount(d1: D1WithBatch, userId: string): Promise<boolean> {
  await Promise.all([refreshOwnersFrom(d1), refreshPermissionsFrom(d1)]);
  return isAdmin(await emailOf(d1, userId));
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
  const mode = providerSettleMode(provider);
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
    const r =
      mode === "test"
        ? await refundTestTopup(d1, refId, now)
        : await refundProviderTopup(d1, refId, now, "refunded at the provider");
    // `marked`: refunded before it was credited — the mark blocks a late capture.
    if (r.status === "insufficient" || r.status === "marked")
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

  if (mode === "test" && !(await ownerAccount(d1, out.userId))) {
    console.warn(
      JSON.stringify({ event: "credits.webhook.test-ignored", provider: provider.id, refId }),
    );
    return { status: 200, body: { received: true, status: "ignored" } };
  }
  const r =
    mode === "test"
      ? await creditTestTopup(
          d1,
          {
            userId: out.userId,
            amount: out.amount,
            provider: provider.id,
            paymentId: out.paymentId,
          },
          now,
        )
      : await creditTopup(
          d1,
          {
            userId: out.userId,
            amount: out.amount,
            provider: provider.id,
            paymentId: out.paymentId,
            reason: provider.kind === "grant" ? "sponsor" : "topup",
          },
          now,
        );
  if (r.status === "no user") console.warn("[payments] credit for unknown user", provider.id);
  return { status: 200, body: { received: true, status: r.status } };
}
