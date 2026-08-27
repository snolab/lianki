import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import AiVocabClient from "./AiVocabClient";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  return {
    title: "AI Vocabulary Practice — Lianki",
    description:
      "Practice vocabulary with AI-generated sentences. Get contextual example sentences for any word in your target language.",
    ...generateAppHreflangMetadata(locale, "/ai-vocab"),
  };
}

export default async function AiVocabPage() {
  const locale = await appLocale();
  const { title, description, selectLanguage } = getIntlayer("ai-vocab-page", locale);

  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <AiVocabClient
          locale={locale}
          title={title}
          description={description}
          selectLanguage={selectLanguage}
        />
      </div>
    </div>
  );
}
