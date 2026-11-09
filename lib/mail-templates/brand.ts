/**
 * The product name as mail writes it — the ONE place to change it
 * (docs/mail-templates.md, "Brand"). Templates never spell the name: they say
 * `{brand}` (the short name) or `{brandLong}` (the name with "Lianki" beside it
 * where the short one is not "Lianki"), and every send fills both from here,
 * stored edits included.
 *
 * Chinese mail says 炼記 today (owner decision pending, 2026-11-09).
 */
import type { MailLocale } from "./locales";

export const MAIL_BRAND = "Lianki";
/** The Chinese mails' name, Simplified and Traditional alike. */
export const MAIL_BRAND_ZH = "炼記";

export function mailBrand(locale: MailLocale): { brand: string; brandLong: string } {
  const zh = locale === "zh" || locale === "zh-Hant";
  const brand = zh ? MAIL_BRAND_ZH : MAIL_BRAND;
  return { brand, brandLong: brand === MAIL_BRAND ? MAIL_BRAND : `${brand}（${MAIL_BRAND}）` };
}
