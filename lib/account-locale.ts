/**
 * The UI language of a signed-in request, on the server (docs/prefs-sync.md,
 * "UI language on the server").
 *
 * The middleware stays session-free: it picks ?lang= → the `lang` cookie →
 * Accept-Language and says which one it used (LOCALE_SRC_HEADER). For an app
 * page of a signed-in user, the server then puts the account's language first:
 *
 *   ?lang= (always wins) → the account's `ui.locale` → its `signupLocale`
 *   → the `lang` cookie → Accept-Language
 *
 * The account is read once per device, not on every page: when it has been
 * read (or when the user picked a language by hand in this session), the
 * marker cookie LOCALE_SRC_COOKIE says so and the cookie chain is trusted.
 *
 *   `acct` (a year): the `lang` cookie holds the account's language. Written
 *     after the server read it (AccountLocaleAdopt) and when PrefSync pulls
 *     `ui.locale` (lib/prefs/bindings.ts).
 *   `pick` (this browser session): a language picked by hand, by
 *     LanguageSwitcher or a ?lang= link. Never overridden while it lasts.
 *
 * Chinese: the account's tags may carry a script (`zh-Hans`, `zh-Hant`, from
 * lib/signup-locale.ts); the UI has one Chinese, `zh`, so both read it.
 *
 * Pure: no D1, no request objects. Client-safe.
 */
import { DEFAULT_LOCALE, LOCALE_PARAM, localeFromAcceptLanguage } from "@/lib/app-locale";
import { isSupportedLocale } from "@/lib/constants";
import { mailTemplateLocale } from "@/lib/signup-locale";

/** Set by middleware.ts on app routes: where LOCALE_HEADER's locale came from. */
export const LOCALE_SRC_HEADER = "x-lianki-lang-src";
/** The marker cookie: `acct` or `pick` (see above). */
export const LOCALE_SRC_COOKIE = "lang_src";

export type LocaleSource = "param" | "cookie" | "accept";
export type LocaleMarker = "acct" | "pick";

const YEAR_S = 365 * 24 * 60 * 60;

/** The middleware's chain: ?lang= → `lang` cookie → Accept-Language, and which one decided. */
export function requestLocale(
  param: string | null | undefined,
  cookie: string | null | undefined,
  acceptLanguage: string | null | undefined,
): { locale: string; source: LocaleSource } {
  if (param && isSupportedLocale(param)) return { locale: param, source: "param" };
  if (cookie && isSupportedLocale(cookie)) return { locale: cookie, source: "cookie" };
  return { locale: localeFromAcceptLanguage(acceptLanguage ?? null), source: "accept" };
}

/** Any tag (`zh-Hant`, `ja-JP`, `ko`) → one of the 16 UI locales, or null. */
export function uiLocaleOf(tag: unknown): string | null {
  return mailTemplateLocale(tag);
}

/** The account's language: `ui.locale` → `signupLocale`, or null when neither is one of ours. */
export function accountUiLocale(who: {
  accountLocale?: unknown;
  signupLocale?: unknown;
}): string | null {
  return uiLocaleOf(who.accountLocale) ?? uiLocaleOf(who.signupLocale);
}

export function isLocaleMarker(v: unknown): v is LocaleMarker {
  return v === "acct" || v === "pick";
}

/**
 * Whether this request should read the account's language: a signed-in app
 * page, no ?lang=, and neither marker yet. Cheap to ask before any D1 read.
 */
export function needsAccountLocale(r: {
  source: string | null | undefined;
  marker: string | null | undefined;
  signedIn: boolean;
}): boolean {
  if (!r.signedIn) return false;
  if (r.source === "param") return false;
  return !isLocaleMarker(r.marker);
}

/**
 * The page's locale once the account's language is known (null: none set).
 * `adopt` is what the browser should remember: the `lang` cookie (when the
 * account has a language) and the `acct` marker, so the next page needs no read.
 */
export function withAccountLocale(
  requested: string | null | undefined,
  account: string | null,
): { locale: string; adopt: { locale: string | null } } {
  const fallback = requested && isSupportedLocale(requested) ? requested : DEFAULT_LOCALE;
  return { locale: account ?? fallback, adopt: { locale: account } };
}

/** The cookie lines AccountLocaleAdopt writes: the account's language (if any) and the `acct` marker. */
export function adoptCookieLines(locale: string | null): string[] {
  const tail = `; path=/; max-age=${YEAR_S}; SameSite=Lax`;
  const lines =
    locale && isSupportedLocale(locale)
      ? ["NEXT_LOCALE", LOCALE_PARAM].map((n) => `${n}=${locale}${tail}`)
      : [];
  return [...lines, `${LOCALE_SRC_COOKIE}=acct${tail}`];
}

/** The `pick` marker: a session cookie (no max-age), gone when the browser session ends. */
export const PICK_COOKIE_LINE = `${LOCALE_SRC_COOKIE}=pick; path=/; SameSite=Lax`;
/** The `acct` marker for a year (PrefSync's pulled `ui.locale`). */
export const ACCT_COOKIE_LINE = `${LOCALE_SRC_COOKIE}=acct; path=/; max-age=${YEAR_S}; SameSite=Lax`;
/** Clears the marker (sign-out): the next account's language is read afresh. */
export const CLEAR_MARKER_LINE = `${LOCALE_SRC_COOKIE}=; path=/; max-age=0; SameSite=Lax`;

/**
 * A stored pref value (JSON text, user_prefs.value) → the string it holds, or null.
 */
export function prefString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
