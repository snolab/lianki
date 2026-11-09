import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { handleResendWebhook } from "@/lib/resend-webhook";

/**
 * Resend's webhook — bounces and complaints, pushed by Resend; nothing polls.
 * Register https://lianki.com/api/email/resend-webhook in Resend → Webhooks
 * with the events `email.bounced` and `email.complained`; its signing secret is
 * RESEND_WEBHOOK_SECRET. 503 until that secret exists. lib/resend-webhook.ts;
 * docs/secrets-and-auth.md, "Resend webhook".
 */
export const POST = (req: Request) =>
  dbBackend() === "d1"
    ? handleResendWebhook(req, {
        secret: () => process.env.RESEND_WEBHOOK_SECRET,
        db: () => getD1() as unknown as D1Like,
      })
    : Response.json({ error: "Not found" }, { status: 404 });
