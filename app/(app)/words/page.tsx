import type { Metadata } from "next";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import WordsClient from "./WordsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  return {
    title: "Word lists - Lianki",
    description: "Fast vocabulary review: a screen of words at once, graded by exception, on FSRS.",
    ...generateAppHreflangMetadata(locale, "/words"),
  };
}

export default function WordsPage() {
  // The (app) layout supplies the shell, auth and the Intlayer providers.
  return <WordsClient />;
}
