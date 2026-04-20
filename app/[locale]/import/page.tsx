import type { Metadata } from "next";
import { authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { getLocale } from "next-intlayer/server";
import type { Locale } from "intlayer";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import ImportClient from "./ImportClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: "Import Anki Deck — Lianki",
    description: "Import your existing Anki flashcard decks (.apkg files) into Lianki.",
    ...generateHreflangMetadata(locale, "/import"),
  };
}

export default async function ImportPage() {
  const locale = await getLocale();
  const { appName, nav } = getIntlayer("landing-page", locale as Locale);
  const { title, description, dropzone, maxSize, uploading, importButton } = getIntlayer(
    "import-page",
    locale as Locale
  );

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
        <ImportClient
          title={title}
          description={description}
          dropzone={dropzone}
          maxSize={maxSize}
          uploading={uploading}
          importButton={importButton}
        />
      </main>
    </div>
  );
}
