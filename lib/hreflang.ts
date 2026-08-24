import type { Metadata } from "next";
import { LANG_TAGS, BLOG_LOCALES } from "@/lib/constants";
import { DEFAULT_LOCALE, LOCALE_PARAM } from "@/lib/app-locale";

const LOCALES = BLOG_LOCALES;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://lianki.com";

/**
 * Generate hreflang metadata for a page
 *
 * @param locale - Current locale
 * @param path - Path without locale prefix (e.g., "/list", "/blog/my-post")
 * @returns Metadata with alternates for SEO
 *
 * @example
 * // In a page's generateMetadata:
 * export async function generateMetadata({ params }) {
 *   const { locale } = await params;
 *   return generateHreflangMetadata(locale, "/list");
 * }
 */
export function generateHreflangMetadata(
  locale: string,
  path: string = "",
): Pick<Metadata, "alternates"> {
  // Ensure path starts with / if provided
  const normalizedPath = path && !path.startsWith("/") ? `/${path}` : path;

  // Generate hreflang alternates for all locales
  const languages: Record<string, string> = {};

  LOCALES.forEach((loc) => {
    const langTag = LANG_TAGS[loc] || loc;
    languages[langTag] = `${BASE_URL}/${loc}${normalizedPath}`;
  });

  return {
    alternates: {
      canonical: `${BASE_URL}/${locale}${normalizedPath}`,
      languages: {
        ...languages,
        "x-default": `${BASE_URL}/en${normalizedPath}`, // Default to English
      },
    },
  };
}

/**
 * Hreflang metadata for app routes, which carry the locale in ?lang= rather than
 * a path prefix. The default locale is the bare URL, so it doubles as x-default.
 */
export function generateAppHreflangMetadata(
  locale: string,
  path: string,
): Pick<Metadata, "alternates"> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = (loc: string) =>
    loc === DEFAULT_LOCALE
      ? `${BASE_URL}${normalizedPath}`
      : `${BASE_URL}${normalizedPath}?${LOCALE_PARAM}=${loc}`;

  const languages: Record<string, string> = {};
  LOCALES.forEach((loc) => {
    languages[LANG_TAGS[loc] || loc] = url(loc);
  });

  return {
    alternates: {
      canonical: url(locale),
      languages: { ...languages, "x-default": url(DEFAULT_LOCALE) },
    },
  };
}
