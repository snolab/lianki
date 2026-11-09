/**
 * Sign-in mail (code or link): templates `signin-code` / `signin-link`
 * (lib/mail-templates, docs/mail-templates.md). auth-impl.ts sends them through
 * the template store in the account's language; these helpers are the
 * request-only language and the built-in render.
 *
 * Both parts are always there: a bare one-link HTML mail tends to be filed as
 * spam, so every mail carries a plain-text part too.
 */
import { renderBuiltin } from "@/lib/mail-templates/compose";
import { pickMailLocale, type MailLocale } from "@/lib/mail-templates/locales";
import { requestLocaleTags } from "@/lib/mail-templates/recipient-locale";

export type { MailLocale };

/** The request's language alone: app locale header, then Accept-Language, then en. */
export function mailLocale(ctx?: { headers?: Headers | null } | null): MailLocale {
  return pickMailLocale(...requestLocaleTags(ctx?.headers));
}

/** The built-in sign-in mail (no stored edit), for tests and previews. */
export function signInMail(
  locale: MailLocale,
  what: { otp: string } | { url: string },
): { subject: string; text: string; html: string } {
  const { subject, text, html } =
    "otp" in what
      ? renderBuiltin("signin-code", locale, { code: what.otp })
      : renderBuiltin("signin-link", locale, { url: what.url });
  return { subject, text, html };
}
