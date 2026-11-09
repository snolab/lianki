/**
 * The one send path's log (docs/mail-templates.md, "Send log"): wraps a send
 * function (Resend, or a local stub) so every mail gets a mail_log row —
 * queued before the provider is called, then sent with its message id, or
 * failed with a short reason. The row's id rides along as the `mail_log` tag,
 * so Resend's webhook can name it.
 *
 * The log never blocks a mail: a D1 error is reported (no address) and the
 * mail goes out anyway. Only allow-listed variables are stored (./vars.ts), so
 * a sign-in code or link can never reach the table, whatever a caller passes.
 */
import type { SendEmailInput } from "@/lib/email";
import { recipientHash } from "@/lib/referrals/recipient-hash";
import { insertQueued, markFailed, markSent, type MailLogDb } from "./store";
import { MAIL_LOG_TAG, storedVars } from "./vars";

export type Send = (mail: SendEmailInput) => Promise<{ id?: string } | unknown>;

const logError = (event: string, e: unknown) =>
  console.error(JSON.stringify({ event, error: String(e).slice(0, 200) }));

/** `send`, with every mail written to the send log when a D1 is there. */
export function withMailLog(
  db: () => MailLogDb | null,
  send: Send,
  now: () => number = Date.now,
): (mail: SendEmailInput) => Promise<{ id: string }> {
  return async (mail) => {
    const { log, ...rest } = mail;
    let d: MailLogDb | null = null;
    const id = crypto.randomUUID();
    try {
      d = db();
      if (d) {
        const template = log?.template ?? "unknown";
        await insertQueued(
          d,
          {
            id,
            template,
            version: log?.version ?? 0,
            locale: log?.locale ?? "en",
            recipient: mail.to,
            recipientHash: await recipientHash(mail.to),
            userId: log?.userId,
            inviterId: log?.inviterId,
            inviteLogId: log?.inviteLogId,
            vars: storedVars(template, log?.vars),
            resendOf: log?.resendOf,
          },
          now(),
        );
      }
    } catch (e) {
      logError("mail-log.write-failed", e);
      d = null;
    }
    const tags = d ? [...(rest.tags ?? []), { name: MAIL_LOG_TAG, value: id }] : rest.tags;
    let res: { id?: string } | undefined;
    try {
      res = (await send({ ...rest, ...(tags ? { tags } : {}) })) as { id?: string } | undefined;
    } catch (e) {
      if (d) await settle(markFailed(d, id, String(e), now()));
      throw e;
    }
    const providerId = typeof res?.id === "string" ? res.id : "";
    if (d) await settle(markSent(d, id, providerId, now()));
    return { id: providerId };
  };
}

/** A log write after the send: its failure is reported, never thrown over the mail's outcome. */
async function settle(write: Promise<void>) {
  try {
    await write;
  } catch (e) {
    logError("mail-log.write-failed", e);
  }
}
