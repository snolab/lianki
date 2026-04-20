import type { Metadata } from "next";
import { authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import ImportClient from "./ImportClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: "Import Anki Deck — Lianki",
    description: "Import your existing Anki flashcard decks (.apkg files) into Lianki.",
    ...generateHreflangMetadata(locale, "/import"),
  };
}

export default async function ImportPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const { appName, nav } = getIntlayer("landing-page", locale);

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
        user={user}
      />
      <main className="flex-grow">
        <ImportClient />
      </main>
    </div>
  );
}
