/**
 * Shared facts for the legal pages (/legal/*) and the footer that links them.
 *
 * The two placeholders are owner decisions: this repo is public, so the owner's
 * legal name never goes in it as a guess, and there is no support mailbox yet
 * (EMAIL_FROM is a no-reply sender). Replace them here and every page follows.
 */
export const SUPPORT_EMAIL = "{{SUPPORT_EMAIL}}";
export const OWNER_LEGAL_NAME = "{{OWNER_LEGAL_NAME}}";

/** Trade name (屋号) of the sole proprietor selling Lianki. */
export const SELLER = "SNOLAB";
export const SITE_URL = "https://lianki.com";

/** Shown as "Last updated" on every legal page. ISO, never 10/30/2026. */
export const LEGAL_UPDATED = "2026-10-30";

export type LegalSlug = "terms" | "privacy" | "refund" | "tokushoho";
export const LEGAL_SLUGS: readonly LegalSlug[] = ["terms", "privacy", "refund", "tokushoho"];

/** Locales the legal text is written in; the rest read English with a note. */
export type LegalLocale = "en" | "ja";
export const legalLocale = (locale: string): LegalLocale => (locale === "ja" ? "ja" : "en");

interface LegalLabels {
  pages: Record<LegalSlug, string>;
  contact: string;
  updated: string;
  fallbackNote: string;
}

export const LEGAL_LABELS: Record<LegalLocale, LegalLabels> = {
  en: {
    pages: {
      terms: "Terms of Service",
      privacy: "Privacy Policy",
      refund: "Refund Policy",
      tokushoho: "Specified Commercial Transactions Act",
    },
    contact: "Contact",
    updated: "Last updated",
    fallbackNote:
      "This page is available in English and Japanese only. The English text is shown here.",
  },
  ja: {
    pages: {
      terms: "利用規約",
      privacy: "プライバシーポリシー",
      refund: "返金ポリシー",
      tokushoho: "特定商取引法に基づく表記",
    },
    contact: "お問い合わせ",
    updated: "最終更新日",
    fallbackNote: "",
  },
};
