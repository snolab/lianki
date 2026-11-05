import { BLOG_LOCALES, isSupportedLocale } from "@/lib/constants";

export const LOCALE_HEADER = "x-lianki-lang";

/**
 * Set by middleware.ts on /embed/partner only (and stripped everywhere
 * else): the root layout then mounts none of the owner's page boots
 * (DebugEval, hot islands, the service worker, the version notice). That
 * route is framable by any site (frame-ancestors *), so it must never open a
 * cookie socket or show pairing / Allow UI (docs/dev-debug-widget.md, "The frame").
 */
export const PARTNER_FRAME_HEADER = "x-lianki-partner-frame";

/** The partner frame's path, and anything under it. */
export function isPartnerFramePath(pathname: string): boolean {
  return pathname === "/embed/partner" || pathname.startsWith("/embed/partner/");
}
export const LOCALE_PARAM = "lang";
export const DEFAULT_LOCALE = "en";
/** The UI language once picked by hand (LanguageSwitcher), synced with the account: docs/prefs-sync.md. */
export const LOCALE_PICK_KEY = "lk:ui-locale";

export const APP_ROUTES = [
  "add-note",
  "cli-login",
  "ai-vocab",
  "alphabet",
  // app/auth/logout, outside app/(app)/: the sign-out page (lib/sign-out.ts).
  "auth",
  "books",
  "connections",
  "contact",
  "contacts",
  "data",
  "dev",
  "embed",
  "home",
  "i",
  "import",
  "lab",
  "learn",
  "list",
  "membership",
  "next",
  "polyglot",
  "preferences",
  "privacy",
  "profile",
  "read",
  "review",
  "roadmap",
  "self-intro",
  "sign-in",
  "stats",
  "words",
  "sites",
] as const;

export function isAppRoute(pathname: string): boolean {
  const segment = pathname.split("/")[1] ?? "";
  return (APP_ROUTES as readonly string[]).includes(segment);
}

/**
 * The locale of a bare locale root ("/zh", the landing page), else null.
 * middleware.ts serves these itself: intlayer's middleware rewrites "/zh" to
 * "/zh/", and next dev answers that trailing slash with a 308 back to "/zh",
 * so the browser looped until ERR_TOO_MANY_REDIRECTS (owner, 2026-11-03
 * 14:56 JST, on the whole-page dev server; every locale root, and "/" too,
 * which redirects to "/en/").
 */
export function localeRoot(pathname: string): string | null {
  const m = /^\/([a-z]{2})$/.exec(pathname);
  return m && isSupportedLocale(m[1]) ? m[1] : null;
}

export function resolveLocale(candidate: string | null | undefined): string {
  return candidate && isSupportedLocale(candidate) ? candidate : DEFAULT_LOCALE;
}

export function localeFromAcceptLanguage(header: string | null): string {
  for (const part of header?.split(",") ?? []) {
    const tag = part.split(";")[0].trim().toLowerCase();
    const base = tag.split("-")[0];
    const hit = BLOG_LOCALES.find((l) => l === tag || l === base);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}
