import type { Metadata } from "next";
import { appLocale } from "@/lib/app-locale.server";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { LEGAL_LABELS, legalLocale } from "@/lib/legal";
import { LegalDoc } from "../LegalDoc";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  return {
    title: `${LEGAL_LABELS[legalLocale(locale)].pages.privacy} - Lianki`,
    ...generateAppHreflangMetadata(locale, "/legal/privacy"),
  };
}

export default async function Page() {
  return <LegalDoc slug="privacy" locale={await appLocale()} />;
}
