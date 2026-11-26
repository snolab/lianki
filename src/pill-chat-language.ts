/** Non-secret display language, copied only from the user's first-party Lianki UI. */
import { PILL_CHAT_LOCALES, pillChatLang, type PillChatLocale } from "./pill-chat-strings";
import type { GmStore } from "./pill-chat-trust";
export const PILL_UI_LANGUAGE_KEY = "lianki_lichat_ui_language_v1";
const UI_ORIGINS = new Set([
  "https://lianki.com",
  "https://www.lianki.com",
  "https://preview.lianki.com",
]);
export function portableUiLocale(value: unknown): PillChatLocale | null {
  if (typeof value !== "string") return null;
  const base = value.toLowerCase().split(/[-_]/)[0];
  return (PILL_CHAT_LOCALES as readonly string[]).includes(base!) ? (base as PillChatLocale) : null;
}
export function readPortableUiLanguage(gm: GmStore, fallback?: string | null): PillChatLocale {
  return portableUiLocale(gm.getValue(PILL_UI_LANGUAGE_KEY)) ?? pillChatLang(fallback);
}
/** A foreign page, an embedded first-party frame or an empty document cannot replace it. */
export function rememberPortableUiLanguage(
  gm: GmStore,
  origin: string,
  language: unknown,
  top: boolean,
): boolean {
  const locale = portableUiLocale(language);
  if (!top || !UI_ORIGINS.has(origin) || !locale) return false;
  if (gm.getValue(PILL_UI_LANGUAGE_KEY) !== locale) gm.setValue(PILL_UI_LANGUAGE_KEY, locale);
  return true;
}
