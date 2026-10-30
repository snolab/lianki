/**
 * The wordmark beside the seal in the top bar (app/components/BrandName.tsx).
 *
 * CJK locales show a CJK name with the address after it: 鏈記 (lianki.com).
 * One constant per locale, so a locale's own form is a one-line change (the
 * owner may yet pick simplified 链记 for zh). Every other locale reads
 * Lianki.com — the address is the brand.
 */
export const CJK_WORDMARK: Readonly<Record<string, string>> = {
  zh: "鏈記",
  ja: "鏈記",
  ko: "鏈記",
};

/** The domain written after a CJK wordmark. */
export const BRAND_DOMAIN = "lianki.com";

/** The CJK wordmark for `locale`, or null where the wordmark is Lianki.com. */
export function cjkWordmark(locale: string | undefined): string | null {
  return (locale && CJK_WORDMARK[locale]) || null;
}

/** The whole wordmark as read: "鏈記 (lianki.com)" or "Lianki.com". */
export function wordmarkText(locale: string | undefined): string {
  const cjk = cjkWordmark(locale);
  return cjk ? `${cjk} (${BRAND_DOMAIN})` : "Lianki.com";
}
