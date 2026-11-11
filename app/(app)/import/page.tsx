import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import ImportClient from "./ImportClient";
import YamlImportSection from "./YamlImportSection";
import PasteLinksSection from "./PasteLinksSection";
import WordListImport from "./WordListImport";
import { authUserOrNull } from "@/app/signInEmail";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { importAnyOn } from "@/lib/import/words-handler";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const t = getIntlayer("import-page", locale);
  return {
    title: t.metaTitle,
    description: t.metaDescription,
    ...generateAppHreflangMetadata(locale, "/import"),
  };
}

export default async function ImportPage() {
  const locale = await appLocale();
  let email: string | null = null;
  try {
    email = (await authUserOrNull())?.email ?? null;
  } catch {
    // Guest: the paste importer renders disabled with a sign-in hint.
  }
  const isLoggedIn = Boolean(email);
  // The word-list import (docs/import-material.md): every signed-in user while
  // `import.any` is on; the owner on or off (importAnyOn).
  const wordListOn = !!email && importAnyOn(await readFlags(), isDev(email));
  const t = getIntlayer("import-page", locale);

  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <div className="max-w-2xl mx-auto px-8 pb-16">
          <ImportClient />
          {wordListOn && <WordListImport signedIn={isLoggedIn} />}
          <PasteLinksSection isLoggedIn={isLoggedIn} />
          <YamlImportSection />
          <p className="mt-8 text-sm text-gray-500 dark:text-gray-400">
            {t.dataToolsLead}{" "}
            <a href="/data" className="underline font-medium">
              {t.dataToolsLink}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
