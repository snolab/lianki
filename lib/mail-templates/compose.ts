/**
 * Compose a transactional mail through the template store
 * (docs/mail-templates.md). Every mail Lianki sends goes through here, so an
 * edit at /dev/templates changes the real mail.
 *
 * FAIL-SAFE: a stored edit that cannot be read, was written for an older
 * variable set, or does not validate or render is skipped, and the built-in
 * default goes out instead — a sign-in mail is never blocked by a template.
 * The event is logged without any address: template, language, version and
 * the reason.
 */
import { mailBrand } from "./brand";
import { MAIL_TEMPLATES, type MailTemplateId } from "./defs";
import { renderSource, TemplateRenderError, type TemplateSource } from "./engine";
import type { MailLocale } from "./locales";
import { activeStored, type TemplateDb } from "./store";

export type MailValues = Record<string, string | number | null | undefined>;

export type ComposedMail = TemplateSource & {
  template: MailTemplateId;
  locale: MailLocale;
  /** The stored version sent; 0 = the built-in default. */
  version: number;
};

const withBrand = (locale: MailLocale, values: MailValues): MailValues => ({
  ...values,
  ...mailBrand(locale),
});

/** The built-in default, rendered. Throws only on a bug in code (tests cover every template). */
export function renderBuiltin(
  id: MailTemplateId,
  locale: MailLocale,
  values: MailValues,
): ComposedMail {
  const def = MAIL_TEMPLATES[id];
  return {
    ...renderSource(def.builtin(locale), def.vars, withBrand(locale, values)),
    template: id,
    locale,
    version: 0,
  };
}

/** A source (stored or being edited) rendered as a send would, without a fallback. */
export function renderWith(
  id: MailTemplateId,
  locale: MailLocale,
  source: TemplateSource,
  values: MailValues,
): TemplateSource {
  return renderSource(source, MAIL_TEMPLATES[id].vars, withBrand(locale, values));
}

function logFallback(id: MailTemplateId, locale: MailLocale, version: number, reason: string) {
  console.error(
    JSON.stringify({
      event: "mail.template.fallback",
      template: id,
      locale,
      version,
      reason: reason.slice(0, 200),
    }),
  );
}

/** The mail as it is sent now: the active stored edit, else (or on any failure) the built-in. */
export async function composeMail(
  db: TemplateDb | null | undefined,
  id: MailTemplateId,
  locale: MailLocale,
  values: MailValues,
): Promise<ComposedMail> {
  if (db) {
    let stored = null;
    try {
      stored = await activeStored(db, id, locale);
    } catch (e) {
      logFallback(id, locale, -1, `store: ${String(e)}`);
    }
    if (stored) {
      const def = MAIL_TEMPLATES[id];
      if (stored.schema !== def.schema) logFallback(id, locale, stored.version, "old-schema");
      else
        try {
          return {
            ...renderWith(id, locale, stored, values),
            template: id,
            locale,
            version: stored.version,
          };
        } catch (e) {
          logFallback(
            id,
            locale,
            stored.version,
            e instanceof TemplateRenderError ? e.message : `render: ${String(e)}`,
          );
        }
    }
  }
  return renderBuiltin(id, locale, values);
}
