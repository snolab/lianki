import type { Metadata } from "next";
import { appLocale } from "@/lib/app-locale.server";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { LEGAL_LABELS, legalLocale } from "@/lib/legal";
import { LegalDoc } from "../LegalDoc";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  return {
    title: `${LEGAL_LABELS[legalLocale(locale)].pages.refund} - Lianki`,
    ...generateAppHreflangMetadata(locale, "/legal/refund"),
  };
}

export default async function Page() {
  return <LegalDoc slug="refund" locale={await appLocale()} />;
}
