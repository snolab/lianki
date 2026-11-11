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

export type VersionNoticeStrings = {
  refresh: string;
  /** Auto-update on, page clean: it will reload by itself (lib/auto-update.ts). */
  autoClean: string;
  /** Auto-update on, page dirty: it waits; a tap still reloads. */
  autoDirty: string;
};

export const VERSION_NOTICE_STRINGS: Record<VersionNoticeLocale, VersionNoticeStrings> = {
  en: {
    refresh: "New version · Refresh",
    autoClean: "New version · updates when idle",
    autoDirty: "New version · unsaved changes",
  },
  zh: {
    refresh: "有新版本 · 刷新",
    autoClean: "有新版本，空闲时自动更新",
    autoDirty: "有新版本，有未保存内容",
  },
  hi: {
    refresh: "नया संस्करण · रीफ़्रेश करें",
    autoClean: "नया संस्करण · खाली होने पर अपने-आप अपडेट",
    autoDirty: "नया संस्करण · बिना सहेजे बदलाव",
  },
  es: {
    refresh: "Nueva versión · Actualizar",
    autoClean: "Nueva versión · se actualiza en reposo",
    autoDirty: "Nueva versión · cambios sin guardar",
  },
  fr: {
    refresh: "Nouvelle version · Actualiser",
    autoClean: "Nouvelle version · mise à jour au repos",
    autoDirty: "Nouvelle version · modifications non enregistrées",
  },
  ar: {
    refresh: "إصدار جديد · تحديث",
    autoClean: "إصدار جديد · يُحدَّث تلقائيًا عند الخمول",
    autoDirty: "إصدار جديد · تغييرات غير محفوظة",
  },
  bn: {
    refresh: "নতুন সংস্করণ · রিফ্রেশ করুন",
    autoClean: "নতুন সংস্করণ · অবসরে নিজে থেকে আপডেট",
    autoDirty: "নতুন সংস্করণ · অসংরক্ষিত পরিবর্তন",
  },
  pt: {
    refresh: "Nova versão · Atualizar",
    autoClean: "Nova versão · atualiza quando ocioso",
    autoDirty: "Nova versão · alterações não salvas",
  },
  ru: {
    refresh: "Новая версия · Обновить",
    autoClean: "Новая версия · обновится в простое",
    autoDirty: "Новая версия · несохранённые изменения",
  },
  ur: {
    refresh: "نیا ورژن · ریفریش کریں",
    autoClean: "نیا ورژن · فارغ ہونے پر خودکار اپڈیٹ",
    autoDirty: "نیا ورژن · غیر محفوظ تبدیلیاں",
  },
  id: {
    refresh: "Versi baru · Muat ulang",
    autoClean: "Versi baru · diperbarui saat senggang",
    autoDirty: "Versi baru · perubahan belum disimpan",
  },
  de: {
    refresh: "Neue Version · Neu laden",
    autoClean: "Neue Version · Update im Leerlauf",
    autoDirty: "Neue Version · ungespeicherte Änderungen",
  },
  ja: {
    refresh: "新しいバージョン · 再読み込み",
    autoClean: "新しいバージョン · 操作がないときに自動更新",
    autoDirty: "新しいバージョン · 未保存の内容あり",
  },
  sw: {
    refresh: "Toleo jipya · Onyesha upya",
    autoClean: "Toleo jipya · husasishwa ukiwa huna shughuli",
    autoDirty: "Toleo jipya · mabadiliko hayajahifadhiwa",
  },
  mr: {
    refresh: "नवीन आवृत्ती · रिफ्रेश करा",
    autoClean: "नवीन आवृत्ती · मोकळ्या वेळी आपोआप अपडेट",
    autoDirty: "नवीन आवृत्ती · जतन न केलेले बदल",
  },
  ko: {
    refresh: "새 버전 · 새로고침",
    autoClean: "새 버전 · 쉬는 동안 자동 업데이트",
    autoDirty: "새 버전 · 저장하지 않은 변경 사항",
  },
};

export const VERSION_NOTICE_CONTEXT: Record<keyof VersionNoticeStrings, string> = {
  refresh:
    "Floating pill button at the bottom right of every page, shown after a new version of the app was deployed: tapping it reloads the page. Two parts joined by ' · ': a short noun phrase ('New version') and an imperative verb ('Refresh' = reload the page). Keep the ' · '.",
  autoClean:
    "The same pill when the app will update itself: the page has nothing unsaved, so it reloads on its own the next time the user is idle, leaves the app or opens another page. A state, not a command: a noun phrase ('New version'), the separator, then a short phrase saying it updates by itself when idle. Tapping it still reloads at once. Chinese uses a comma instead of ' · '.",
  autoDirty:
    "The same pill when the app would update itself but waits: the page holds something a reload would lose (typed text, a recording, audio playing, a dialog). A state, not a command: 'New version', the separator, then a noun phrase for 'unsaved changes'. Tapping it still reloads at once. Chinese uses a comma instead of ' · '.",
};

/** The strings for a page `lang` such as "zh-CN"; English when the language is not one of ours. */
export function versionNoticeStrings(lang: string | undefined): VersionNoticeStrings {
  const base = (lang ?? "").toLowerCase().split("-")[0] as VersionNoticeLocale;
  return VERSION_NOTICE_STRINGS[base] ?? VERSION_NOTICE_STRINGS.en;
}
