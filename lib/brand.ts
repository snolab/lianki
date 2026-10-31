/**
 * The wordmark beside the seal in the top bar (app/components/BrandName.tsx).
 *
 * CJK locales show a CJK name with the address after it: 鏈記 (lianki.com).
 * One constant per locale, so a locale's own form is a one-line change (the
 * owner may yet pick simplified 链记 for zh). Every other locale reads
 * Lianki.com — the address is the brand.
 *
 * Not an intlayer string on purpose: the wordmark is the owner's pick, never
 * machine-translated (docs/i18n.md). Context, for anyone changing it: the logo
 * text in the top bar, beside the seal icon, linking home; a proper name read
 * as the product's name, never a phrase to translate. 鏈 "chain" + 記 "record",
 * traditional characters in all three locales; keep "lianki.com" as is.
 */
export const CJK_WORDMARK: Readonly<Record<string, string>> = {
  /** Chinese: the logo text (traditional 鏈記, not the landing page's appName 炼記). */
  zh: "鏈記",
  /** Japanese: the same characters, read as the brand name. */
  ja: "鏈記",
  /** Korean: hanja wordmark, the brand's CJK form (not the hangul appName 련키). */
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
