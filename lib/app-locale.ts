import { BLOG_LOCALES, isSupportedLocale } from "@/lib/constants";

export const LOCALE_HEADER = "x-lianki-lang";
export const LOCALE_PARAM = "lang";
export const DEFAULT_LOCALE = "en";

export const APP_ROUTES = [
  "add-note",
  "ai-vocab",
  "contact",
  "data",
  "import",
  "learn",
  "list",
  "membership",
  "next",
  "polyglot",
  "preferences",
  "profile",
  "read",
  "roadmap",
  "self-intro",
  "sign-in",
] as const;

export function isAppRoute(pathname: string): boolean {
  const segment = pathname.split("/")[1] ?? "";
  return (APP_ROUTES as readonly string[]).includes(segment);
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

export function appHref(path: string, locale: string): string {
  if (locale === DEFAULT_LOCALE) return path;
  const [base, hash] = path.split("#");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${LOCALE_PARAM}=${locale}${hash ? `#${hash}` : ""}`;
}
