import type { Metadata } from "next";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import WordsClient, { type DrillConfig } from "../words/WordsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  return {
    title: "Alphabets - Lianki",
    description: "Drill writing systems both ways — symbol to sound and sound to symbol — on FSRS.",
    ...generateAppHreflangMetadata(locale, "/alphabet"),
  };
}

const ALPHABET: DrillConfig = {
  base: "/alphabets",
  title: "Alphabets",
  intro:
    "Symbol → sound and sound → symbol, in one endless list. Grade each with 1 / 2 / 3 / 4; Z undoes.",
};

export default function AlphabetPage() {
  // Same drill as /words over a different catalog (public/alphabets).
  return <WordsClient config={ALPHABET} />;
}
