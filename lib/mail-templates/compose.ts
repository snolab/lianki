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
import type { MailLogMeta } from "@/lib/email";
import { storedVars } from "@/lib/mail-log/vars";
import { mailBrand } from "./brand";
import { MAIL_TEMPLATES, type MailTemplateId } from "./defs";
import { renderSource, TemplateRenderError, type TemplateSource } from "./engine";
import { MAIL_KINDS } from "./kinds";
import { mailShell } from "./layout";
import type { MailLocale } from "./locales";
import { oneClickHeaders } from "./unsubscribe-token";
import { activeStored, type TemplateDb } from "./store";

export type MailValues = Record<string, string | number | null | undefined>;

/** What the shared layout needs beyond the template (./layout.ts). */
export type ShellOptions = {
  /**
   * An `optional` kind's one-click unsubscribe (./unsubscribe-token.ts): the
   * page a person opens, and the RFC 8058 endpoint for the headers.
   */
  unsubscribe?: { pageUrl: string; oneClickUrl: string };
};

export type ComposedMail = TemplateSource & {
  /** Mail headers the layout adds (List-Unsubscribe for a one-click kind). */
  headers?: Record<string, string>;
  template: MailTemplateId;
  locale: MailLocale;
  /** The stored version sent; 0 = the built-in default. */
  version: number;
  /**
   * For the send log (lib/mail-log): template, version, language and only the
   * variables it may keep (never a code, link or token). Pass it on as the
   * send's `log`, with the user / inviter ids the caller knows.
   */
  log: MailLogMeta;
};

const logMeta = (
  id: MailTemplateId,
  locale: MailLocale,
  version: number,
  values: MailValues,
): MailLogMeta => ({ template: id, version, locale, vars: storedVars(id, values) });

const withBrand = (locale: MailLocale, values: MailValues): MailValues => ({
  ...values,
  ...mailBrand(locale),
});

/**
 * A rendered template in the shared layout (./layout.ts): brand heading,
 * colours as hex, the footer of its kind, and its unsubscribe headers.
 */
export function inLayout(
  id: MailTemplateId,
  locale: MailLocale,
  mail: TemplateSource,
  opts: ShellOptions = {},
): TemplateSource & { headers?: Record<string, string> } {
  const oneClick = MAIL_KINDS[id].optOut === "one-click" ? opts.unsubscribe : undefined;
  const { html, text } = mailShell({
    id,
    locale,
    brand: mailBrand(locale).brand,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    unsubscribeUrl: oneClick?.pageUrl,
  });
  return {
    subject: mail.subject,
    html,
    text,
    ...(oneClick ? { headers: oneClickHeaders(oneClick.oneClickUrl) } : {}),
  };
}

/** The built-in default, rendered. Throws only on a bug in code (tests cover every template). */
export function renderBuiltin(
  id: MailTemplateId,
  locale: MailLocale,
  values: MailValues,
  opts?: ShellOptions,
): ComposedMail {
  const def = MAIL_TEMPLATES[id];
  return {
    ...inLayout(
      id,
      locale,
      renderSource(def.builtin(locale), def.vars, withBrand(locale, values)),
      opts,
    ),
    template: id,
    locale,
    version: 0,
    log: logMeta(id, locale, 0, values),
  };
}

/** A source (stored or being edited) rendered as a send would, in the layout, without a fallback. */
export function renderWith(
  id: MailTemplateId,
  locale: MailLocale,
  source: TemplateSource,
  values: MailValues,
  opts?: ShellOptions,
): TemplateSource & { headers?: Record<string, string> } {
  return inLayout(
    id,
    locale,
    renderSource(source, MAIL_TEMPLATES[id].vars, withBrand(locale, values)),
    opts,
  );
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
  opts?: ShellOptions,
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
            ...renderWith(id, locale, stored, values, opts),
            template: id,
            locale,
            version: stored.version,
            log: logMeta(id, locale, stored.version, values),
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
  return renderBuiltin(id, locale, values, opts);
}
