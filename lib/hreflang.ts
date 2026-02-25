import type { Metadata } from "next";
import { LANG_TAGS } from "@/lib/constants";

const LOCALES = ["en", "zh", "ja", "ko"] as const;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://www.lianki.com";

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
