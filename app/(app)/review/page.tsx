import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import { isHttpUrl } from "@/lib/review-ui";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { voiceAccess } from "@/lib/words/voice-access";
import ReviewClient from "./ReviewClient";

// The due card is the signed-in user's, and changes with every grade.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { title } = getIntlayer("review-page", locale);
  return { title: `${title} - Lianki`, ...generateAppHreflangMetadata(locale, "/review") };
}

/**
 * /review — page cards reviewed inside the site, for people without the
 * userscript. The bare HTML flow (/api/fsrs/next → /api/fsrs/repeat) is left
 * exactly as it was and linked from the footer; this page only calls the same
 * API. `?url=` (what the bookmarklet opens) asks for that page's card first.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string | string[] }>;
}) {
  // Signed out, the page says so and offers sign-in or the local deck.
  const [user, flags] = await Promise.all([authUserOrNull(), readFlags()]);
  const isLoggedIn = Boolean(user?.email);
  const raw = (await searchParams).url;
  const url = typeof raw === "string" && isHttpUrl(raw) ? raw : null;
  // Voice commands grade here too (docs/voice-mode.md), on the same switch as /words.
  return (
    <ReviewClient
      isLoggedIn={isLoggedIn}
      initialUrl={url}
      voice={voiceAccess(flags, isDev(user?.email))}
    />
  );
}
