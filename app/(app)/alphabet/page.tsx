import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import WordsClient, { type DrillConfig } from "../words/WordsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const t = getIntlayer("words-status", locale);
  return {
    title: String(t.alphabetMetaTitle),
    description: String(t.alphabetMetaDescription),
    ...generateAppHreflangMetadata(locale, "/alphabet"),
  };
}

export default async function AlphabetPage() {
  // Same drill as /words over a different catalog (public/alphabets), in the app's language.
  const t = getIntlayer("words-status", await appLocale());
  const config: DrillConfig = {
    base: "/alphabets",
    title: String(t.alphabetTitle),
    intro: String(t.alphabetIntro),
    allTitle: String(t.alphabetAll),
  };
  return <WordsClient config={config} />;
}
