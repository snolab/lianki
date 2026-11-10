/**
 * The "new version" pill's words (VersionNotice.tsx). It is mounted from the
 * root layout, outside the Intlayer client provider, so it reads this plain
 * table by the page's `lang`; version-notice.content.ts declares the same
 * strings, with their context, for `intlayer fill` (the pill-chat pattern).
 */
export const VERSION_NOTICE_LOCALES = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
  "ko",
] as const;
export type VersionNoticeLocale = (typeof VERSION_NOTICE_LOCALES)[number];

export type VersionNoticeStrings = { refresh: string };

export const VERSION_NOTICE_STRINGS: Record<VersionNoticeLocale, VersionNoticeStrings> = {
  en: { refresh: "New version · Refresh" },
  zh: { refresh: "有新版本 · 刷新" },
  hi: { refresh: "नया संस्करण · रीफ़्रेश करें" },
  es: { refresh: "Nueva versión · Actualizar" },
  fr: { refresh: "Nouvelle version · Actualiser" },
  ar: { refresh: "إصدار جديد · تحديث" },
  bn: { refresh: "নতুন সংস্করণ · রিফ্রেশ করুন" },
  pt: { refresh: "Nova versão · Atualizar" },
  ru: { refresh: "Новая версия · Обновить" },
  ur: { refresh: "نیا ورژن · ریفریش کریں" },
  id: { refresh: "Versi baru · Muat ulang" },
  de: { refresh: "Neue Version · Neu laden" },
  ja: { refresh: "新しいバージョン · 再読み込み" },
  sw: { refresh: "Toleo jipya · Onyesha upya" },
  mr: { refresh: "नवीन आवृत्ती · रिफ्रेश करा" },
  ko: { refresh: "새 버전 · 새로고침" },
};

export const VERSION_NOTICE_CONTEXT: Record<keyof VersionNoticeStrings, string> = {
  refresh:
    "Floating pill button at the bottom right of every page, shown after a new version of the app was deployed: tapping it reloads the page. Two parts joined by ' · ': a short noun phrase ('New version') and an imperative verb ('Refresh' = reload the page). Keep the ' · '.",
};

/** The strings for a page `lang` such as "zh-CN"; English when the language is not one of ours. */
export function versionNoticeStrings(lang: string | undefined): VersionNoticeStrings {
  const base = (lang ?? "").toLowerCase().split("-")[0] as VersionNoticeLocale;
  return VERSION_NOTICE_STRINGS[base] ?? VERSION_NOTICE_STRINGS.en;
}
