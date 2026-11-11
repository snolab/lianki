/**
 * The production send path: Resend (lib/email.ts) through the send log
 * (./send.ts) on the live D1. Every server-side mail goes through `sendMail`
 * (or `localOrSend`, which stubs it on a server on this machine), so every
 * mail gets a mail_log row. docs/mail-templates.md, "Send log".
 */
import { dbBackend, getD1 } from "@/lib/d1";
import { sendEmail, type SendEmailInput } from "@/lib/email";
import { isLocalOrigin } from "@/lib/referrals/local-origin";
import { withMailLog } from "./send";
import type { MailLogDb } from "./store";

const logDb = (): MailLogDb | null =>
  dbBackend() === "d1" ? (getD1() as unknown as MailLogDb) : null;

/** Resend, logged. */
export const sendMail = withMailLog(logDb, sendEmail);

const origin = () => process.env.BETTER_AUTH_BASE_URL ?? "https://lianki.com";

/**
 * A server on this machine (QA, `bun run dev`, wrangler dev) never mails: the
 * send is a stub that logs one line with no address, and the log row is
 * written as for a real one. Only a deployed origin reaches the provider.
 */
export const localOrSend = (event: string) =>
  withMailLog(logDb, async (mail: SendEmailInput) => {
    if (!isLocalOrigin(origin())) return sendEmail(mail);
    console.log(JSON.stringify({ event }));
    return { id: `stub-${crypto.randomUUID()}` };
  });
