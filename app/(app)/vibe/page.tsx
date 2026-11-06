import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { BLOG_LOCALES, isRTLLocale } from "@/lib/constants";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import type { D1Batch } from "@/lib/read/reader-store";
import { vibeAllowed } from "@/lib/vibe/gate";
import { getRetentionDays } from "@/lib/vibe/store";
import VibeClient, { type ConsentText } from "./VibeClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("vibe-page", await appLocale());
  return { title: String(title), robots: { index: false, follow: false } };
}

/**
 * /vibe (docs/vibe.md): 404 unless `read.vibe` is on and this is the owner. The
 * flag has no owner bypass: with it off, nobody gets this page or its routes.
 * Every locale's statement comes down as text, since the consent screen shows
 * the one the user picks for the other person.
 */
export default async function VibePage() {
  const user = await authUserOrNull();
  if (!user?.id || dbBackend() !== "d1") notFound();
  if (!vibeAllowed(await readFlags(), isOwner(user.email ?? null))) notFound();
  const locale = await appLocale();
  const days = await getRetentionDays(getD1() as unknown as D1Batch, user.id);
  const consent: Record<string, ConsentText> = {};
  for (const l of BLOG_LOCALES) {
    const c = getIntlayer("vibe-consent", l);
    consent[l] = {
      heading: String(c.heading),
      lines: [c.what, c.where, c.who, c.keep, c.ask].map((x) =>
        String(x).replaceAll("{days}", String(days)),
      ),
      rtl: isRTLLocale(l),
    };
  }
  return <VibeClient locale={locale} consent={consent} />;
}
