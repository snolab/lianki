/**
 * Centralized constants for the Lianki application
 */

// Supported locales for blog/i18n routes
export const BLOG_LOCALES = ["en", "zh", "ja"] as const;
export type BlogLocale = (typeof BLOG_LOCALES)[number];

export const DEFAULT_LOCALE: BlogLocale = "en";

// Check if a locale is supported
export function isSupportedLocale(locale: string): locale is BlogLocale {
  return BLOG_LOCALES.includes(locale as BlogLocale);
}

// Locale labels for UI display (native names)
export const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  zh: "中文",
  ja: "日本語",
};

// BCP47 lang tags for HTML lang attribute
export const LANG_TAGS: Record<string, string> = {
  en: "en",
  zh: "zh-Hans",
  ja: "ja",
};

// Maps locale code to date locale for formatting
export function getDateLocale(locale: string): string {
  if (locale === "zh") return "zh-CN";
  if (locale === "ja") return "ja-JP";
  return "en-US";
}

// Full language names for translation API
export const LOCALE_NAMES: Record<string, string> = {
  zh: "Simplified Chinese",
  cn: "Simplified Chinese",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  hi: "Hindi",
  es: "Spanish",
  ar: "Arabic",
  bn: "Bengali",
  pt: "Portuguese",
  ru: "Russian",
  ur: "Urdu",
  id: "Indonesian",
  sw: "Swahili",
  mr: "Marathi",
};

// Language type for UI components
export type Language = {
  code: string;
  name: string;
  nativeName: string;
};

// Full language list for language switcher
export const LANGUAGES: Language[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "zh", name: "Chinese (Simplified)", nativeName: "简体中文" },
  { code: "ja", name: "Japanese", nativeName: "日本語" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी" },
  { code: "es", name: "Spanish", nativeName: "Español" },
  { code: "fr", name: "French", nativeName: "Français" },
  { code: "ar", name: "Arabic", nativeName: "العربية" },
  { code: "bn", name: "Bengali", nativeName: "বাংলা" },
  { code: "pt", name: "Portuguese", nativeName: "Português" },
  { code: "ru", name: "Russian", nativeName: "Русский" },
  { code: "ur", name: "Urdu", nativeName: "اردو" },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia" },
  { code: "de", name: "German", nativeName: "Deutsch" },
  { code: "sw", name: "Swahili", nativeName: "Kiswahili" },
  { code: "mr", name: "Marathi", nativeName: "मराठी" },
  { code: "ko", name: "Korean", nativeName: "한국어" },
];

// Domain suggestions for mobile exclude filters
export const DOMAIN_SUGGESTIONS = ["zhihu.com", "twitter.com", "reddit.com"];
