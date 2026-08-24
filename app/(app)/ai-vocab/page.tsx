import type { Metadata } from "next";
import { authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
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
  const { appName, nav } = getIntlayer("landing-page", locale);
  const { title, description, selectLanguage } = getIntlayer("ai-vocab-page", locale);

  let user = null;
  try {
    user = await authUser();
  } catch {
    // User not logged in
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
        signInLabel={nav.signIn}
        dashboardLabel={nav.dashboard}
        profileLabel={nav.profile}
        preferencesLabel={nav.preferences}
        membershipLabel={nav.membership}
        signOutLabel={nav.signOut}
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
