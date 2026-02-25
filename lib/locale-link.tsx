"use client";

import { useLocale } from "next-intlayer";
import Link from "next/link";
import type { ComponentProps } from "react";

/**
 * LocaleLink - A wrapper around Next.js Link that automatically prefixes paths with the current locale
 *
 * Usage:
 *   <LocaleLink href="/profile">Profile</LocaleLink>
 *   // Will render as /en/profile, /zh/profile, etc. based on current locale
 */
export function LocaleLink({ href, ...props }: ComponentProps<typeof Link>) {
  const locale = useLocale();

  // Don't add locale prefix for:
  // - External URLs (http://, https://, mailto:, etc.)
  // - URLs that already have locale prefix
  // - API routes
  // - Static files
  const hrefString = typeof href === "string" ? href : href.pathname || "";
  const isExternal = hrefString.startsWith("http") || hrefString.startsWith("mailto:");
  const hasLocalePrefix = hrefString.match(/^\/(en|zh|ja|ko)\//);
  const isSpecialRoute =
    hrefString.startsWith("/api") ||
    hrefString.startsWith("/_next") ||
    hrefString.startsWith("/auth");

  if (isExternal || hasLocalePrefix || isSpecialRoute) {
    return <Link href={href} {...props} />;
  }

  // Add locale prefix
  const localizedHref = `/${locale.locale}${hrefString}`;

  return <Link href={localizedHref} {...props} />;
}

/**
 * useLocalePath - Hook to get locale-prefixed path
 *
 * Usage:
 *   const localePath = useLocalePath();
 *   router.push(localePath("/profile"));
 */
export function useLocalePath() {
  const locale = useLocale();

  return (path: string) => {
    // Don't add locale prefix for special routes
    if (
      path.startsWith("/api") ||
      path.startsWith("/_next") ||
      path.startsWith("/auth") ||
      path.startsWith("http")
    ) {
      return path;
    }

    // Check if path already has locale prefix
    if (path.match(/^\/(en|zh|ja|ko)\//)) {
      return path;
    }

    return `/${locale.locale}${path}`;
  };
}
