import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import CreditsUsageClient from "./CreditsUsageClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { title } = getIntlayer("credits-usage", locale);
  return {
    title: `${title} - Lianki`,
    ...generateAppHreflangMetadata(locale, "/membership/credits"),
  };
}

/** /membership/credits — every change to the user's own credits (lib/payments/credit-usage.ts). */
export default function CreditsUsagePage() {
  return <CreditsUsageClient />;
}
