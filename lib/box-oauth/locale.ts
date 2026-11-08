/**
 * The box's UI language at sign-in (docs/box-oauth.md, "The box's language").
 *
 * A box is its own host, so lianki.com's `lang` cookie (host-only) never
 * reaches it. Left alone, the box's server picks from Accept-Language, and a
 * landing link it renders (`/<locale>`, fetched by the router) seeds the box's
 * own `lang` cookie with that guess. So right after the code is traded, the
 * box asks lianki.com for the account's language and writes the box's
 * cookies before it opens /home: the language picked by hand on any device
 * (`ui.locale`, docs/prefs-sync.md) first, then the browser's languages.
 *
 * It never writes `lk:ui-locale`: that key means "picked by hand" and would be
 * uploaded to the account. A pulled `ui.locale` is PrefSync's to apply.
 */
import { LOCALE_PARAM, localeFromAcceptLanguage } from "@/lib/app-locale";
import { isSupportedLocale } from "@/lib/constants";

const PREFS_PATH = "/api/prefs";
const LOCALE_KEY = "ui.locale";
const YEAR_S = 365 * 24 * 60 * 60;
/** NEXT_LOCALE for the prefixed landing and blog, `lang` for the app routes (LanguageSwitcher). */
const COOKIES = ["NEXT_LOCALE", LOCALE_PARAM] as const;

/** The account's pick when it is a locale we have, else the first of the browser's we have, else the default. */
export function boxLocale(accountPick: unknown, languages: readonly string[]): string {
  if (typeof accountPick === "string" && isSupportedLocale(accountPick)) return accountPick;
  return localeFromAcceptLanguage(languages.join(","));
}

/** `ui.locale` from an /api/prefs answer, or null (none set, or an odd body). */
export function accountLocaleFrom(body: unknown): string | null {
  const prefs = (body as { prefs?: Record<string, { value?: unknown } | undefined> } | null)?.prefs;
  const value = prefs && typeof prefs === "object" ? prefs[LOCALE_KEY]?.value : undefined;
  return typeof value === "string" && isSupportedLocale(value) ? value : null;
}

/** The cookie lines that make a locale stick on this host. */
export function localeCookieLines(locale: string): string[] {
  return COOKIES.map((n) => `${n}=${locale}; path=/; max-age=${YEAR_S}; SameSite=Lax`);
}

export type BoxLocaleDeps = {
  /** The box's fetch: same-origin /api goes to lianki.com with the token. */
  fetch: (url: string) => Promise<Response>;
  /** navigator.languages */
  languages: readonly string[];
  /** document.cookie = line */
  setCookie: (line: string) => void;
};

/** Writes the box's locale cookies for the signed-in account and returns the locale. Never throws. */
export async function adoptAccountLocale(d: BoxLocaleDeps): Promise<string> {
  let pick: string | null = null;
  try {
    const res = await d.fetch(PREFS_PATH);
    if (res.ok) pick = accountLocaleFrom(await res.json().catch(() => null));
  } catch {}
  const locale = boxLocale(pick, d.languages);
  for (const line of localeCookieLines(locale)) {
    try {
      d.setCookie(line);
    } catch {}
  }
  return locale;
}
