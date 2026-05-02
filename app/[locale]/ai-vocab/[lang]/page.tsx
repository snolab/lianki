import type { Metadata } from "next";
import { authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import AiVocabLangClient from "./AiVocabLangClient";

export const dynamic = "force-dynamic";

const LANGUAGES: Record<string, { name: string; nativeName: string }> = {
  ja: { name: "Japanese", nativeName: "日本語" },
  zh: { name: "Chinese (Mandarin)", nativeName: "中文" },
  ko: { name: "Korean", nativeName: "한국어" },
  en: { name: "English", nativeName: "English" },
  es: { name: "Spanish", nativeName: "Español" },
  fr: { name: "French", nativeName: "Français" },
  de: { name: "German", nativeName: "Deutsch" },
  it: { name: "Italian", nativeName: "Italiano" },
  pt: { name: "Portuguese", nativeName: "Português" },
  ru: { name: "Russian", nativeName: "Русский" },
  ar: { name: "Arabic", nativeName: "العربية" },
  hi: { name: "Hindi", nativeName: "हिन्दी" },
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; lang: string }>;
}): Promise<Metadata> {
  const { locale, lang } = await params;
  const langInfo = LANGUAGES[lang];
  const langDisplay = langInfo ? `${langInfo.nativeName} (${langInfo.name})` : lang.toUpperCase();
  return {
    title: `AI Vocabulary Practice — ${langDisplay} — Lianki`,
    description: `Practice ${langInfo?.name ?? lang} vocabulary with AI-generated contextual sentences.`,
    ...generateHreflangMetadata(locale, `/ai-vocab/${lang}`),
  };
}

export default async function AiVocabLangPage({
  params,
}: {
  params: Promise<{ locale: string; lang: string }>;
}) {
  const { locale, lang } = await params;
  const { appName, nav } = getIntlayer("landing-page", locale);

  const langInfo = LANGUAGES[lang];

  let user = null;
  try {
    user = await authUser();
  } catch {
    // User not logged in
  }

  if (!langInfo) {
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
        <main className="flex-grow flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-bold mb-4">Language not supported</h1>
            <a href={`/${locale}/ai-vocab`} className="text-blue-500 hover:underline">
              ← Back to language selection
            </a>
          </div>
        </main>
      </div>
    );
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
        <AiVocabLangClient
          locale={locale}
          lang={lang}
          langName={langInfo.name}
          langNativeName={langInfo.nativeName}
          isLoggedIn={!!user}
        />
      </main>
    </div>
  );
}
