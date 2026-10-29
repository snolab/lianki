import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import ImportClient from "./ImportClient";
import YamlImportSection from "./YamlImportSection";
import PasteLinksSection from "./PasteLinksSection";
import { authEmail } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  return {
    title: "Import Anki Deck — Lianki",
    description: "Import your existing Anki flashcard decks (.apkg files) into Lianki.",
    ...generateAppHreflangMetadata(locale, "/import"),
  };
}

export default async function ImportPage() {
  const locale = await appLocale();
  let isLoggedIn = false;
  try {
    isLoggedIn = Boolean(await authEmail());
  } catch {
    // Guest: the paste importer renders disabled with a sign-in hint.
  }
  const {
    title,
    description,
    dropzone,
    maxSize,
    importButton,
    parsing,
    syncing,
    importComplete,
    viewDashboard,
  } = getIntlayer("import-page", locale);

  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <div className="max-w-2xl mx-auto px-8 pb-16">
          <ImportClient
            title={title}
            description={description}
            dropzone={dropzone}
            maxSize={maxSize}
            importButton={importButton}
            parsing={parsing}
            syncing={syncing}
            importComplete={importComplete}
            viewDashboard={viewDashboard}
          />
          <PasteLinksSection isLoggedIn={isLoggedIn} />
          <YamlImportSection />
          <p className="mt-8 text-sm text-gray-500 dark:text-gray-400">
            Looking for exports, bulk delete or the storage overview?{" "}
            <a href="/data" className="underline font-medium">
              Full data tools →
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
