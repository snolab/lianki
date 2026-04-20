import type { Metadata } from "next";
import { authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { getLocale } from "next-intlayer/server";
import type { Locale } from "intlayer";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import AiVocabClient from "./AiVocabClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: "AI Vocabulary Practice — Lianki",
    description: "Learn vocabulary with AI-generated contextual sentences",
    ...generateHreflangMetadata(locale, "/ai-vocab"),
  };
}

export default async function AiVocabPage() {
  const locale = await getLocale();
  const { appName, nav } = getIntlayer("landing-page", locale as Locale);
  const { title, description, selectLanguage } = getIntlayer("ai-vocab-page", locale as Locale);

  let user = null;
  try {
    user = await authUser();
  } catch {
    // not logged in
  }

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        importLabel={nav.import}
        aiVocabLabel={nav.aiVocab}
        user={user}
      />
      <main className="flex-grow">
        <AiVocabClient
          locale={locale}
          title={title}
          description={description}
          selectLanguage={selectLanguage}
        />
      </main>
    </div>
  );
}
