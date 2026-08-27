import type { Metadata } from "next";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import AiVocabLangClient from "./AiVocabLangClient";
import { appHref } from "@/lib/app-locale";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";

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
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  const locale = await appLocale();
  const langInfo = LANGUAGES[lang];
  const langDisplay = langInfo ? `${langInfo.nativeName} (${langInfo.name})` : lang.toUpperCase();
  return {
    title: `AI Vocabulary Practice — ${langDisplay} — Lianki`,
    description: `Practice ${langInfo?.name ?? lang} vocabulary with AI-generated contextual sentences.`,
    ...generateAppHreflangMetadata(locale, `/ai-vocab/${lang}`),
  };
}

export default async function AiVocabLangPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const locale = await appLocale();

  const langInfo = LANGUAGES[lang];
  const user = await authUserOrNull();

  if (!langInfo) {
    return (
      <div className="flex flex-col">
        <div className="flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-bold mb-4">Language not supported</h1>
            <a href={appHref("/ai-vocab", locale)} className="text-blue-500 hover:underline">
              ← Back to language selection
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div>
        <AiVocabLangClient
          locale={locale}
          lang={lang}
          langName={langInfo.name}
          langNativeName={langInfo.nativeName}
          isLoggedIn={!!user}
        />
      </div>
    </div>
  );
}
