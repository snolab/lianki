import type { Metadata } from "next";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import { getIntlayer } from "intlayer";
import WordsClient from "./WordsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { wordsTitle, metaDescription } = getIntlayer("words-page", locale);
  return {
    title: `${wordsTitle} - Lianki`,
    description: String(metaDescription),
    ...generateAppHreflangMetadata(locale, "/words"),
  };
}

export default function WordsPage() {
  // The (app) layout supplies the shell, auth and the Intlayer providers.
  return <WordsClient />;
}
