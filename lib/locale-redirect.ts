import { getLocale } from "next-intlayer/server";
import { redirect as nextRedirect } from "next/navigation";

/**
 * Locale-aware redirect for server components
 *
 * Usage in server components:
 *   import { localeRedirect } from "@/lib/locale-redirect";
 *   localeRedirect("/sign-in");  // Redirects to /en/sign-in, /zh/sign-in, etc.
 *
 * For special routes that shouldn't have locale prefix:
 *   localeRedirect("/api/auth/signin", false);
 */
export async function localeRedirect(path: string, addLocale = true): Promise<never> {
  // Don't add locale for special routes
  if (
    path.startsWith("/api") ||
    path.startsWith("/_next") ||
    path.startsWith("/auth") ||
    path.startsWith("http")
  ) {
    return nextRedirect(path);
  }

  // If addLocale is false, redirect without locale
  if (!addLocale) {
    return nextRedirect(path);
  }

  // Check if path already has locale prefix
  if (path.match(/^\/(en|zh|ja|ko)\//)) {
    return nextRedirect(path);
  }

  // Get current locale and add prefix
  const locale = await getLocale();
  return nextRedirect(`/${locale}${path}`);
}
