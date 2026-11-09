/**
 * The mails of an address change, through the template store
 * (lib/mail-templates, docs/mail-templates.md): `email-confirm`,
 * `email-taken`, `email-requested`, `email-changed`. In the account's
 * language (`ui.locale` → `signupLocale`), else the request's — the request
 * comes from the account holder. `address` is the other address, already
 * masked.
 */
import type { MailLogMeta } from "@/lib/email";
import { composeMail } from "@/lib/mail-templates/compose";
import { MAIL_CONTACT_URL, type MailTemplateId } from "@/lib/mail-templates/defs";
import type { MailLocale } from "@/lib/mail-templates/locales";
import { recipientMailLocale, requestLocaleTags } from "@/lib/mail-templates/recipient-locale";
import type { TemplateDb } from "@/lib/mail-templates/store";

type ChangeMailId = Extract<
  MailTemplateId,
  "email-confirm" | "email-taken" | "email-requested" | "email-changed"
>;

export function changeMailLocale(db: unknown, userId: string, req: Request): Promise<MailLocale> {
  return recipientMailLocale(db as TemplateDb, { userId }, ...requestLocaleTags(req.headers));
}

export async function changeMail(
  db: unknown,
  id: ChangeMailId,
  locale: MailLocale,
  values: Record<string, string>,
  userId?: string,
): Promise<{ subject: string; text: string; html: string; log: MailLogMeta }> {
  const { subject, text, html, log } = await composeMail(db as TemplateDb, id, locale, {
    contactUrl: MAIL_CONTACT_URL,
    ...values,
  });
  // For the send log (lib/mail-log): the account the change belongs to.
  return { subject, text, html, log: { ...log, userId: userId ?? null } };
}
