import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import WordsImportClient from "./WordsImportClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { title, intro } = getIntlayer("words-import", locale);
  return {
    title: `${title} - Lianki`,
    description: String(intro),
    ...generateAppHreflangMetadata(locale, "/words/import"),
  };
}

export default function WordsImportPage() {
  // The (app) layout supplies the shell, auth and the Intlayer providers.
  return <WordsImportClient />;
}
