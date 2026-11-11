import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import SelfIntroClient from "./SelfIntroClient";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { selfIntroImportOn } from "@/lib/self-intro/import-handler";
import { importAnyOn } from "@/lib/import/words-handler";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("self-intro-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/self-intro"),
  };
}

export default async function SelfIntroPage() {
  // The import step (docs/self-intro-import.md): signed-in users, dark behind
  // `self-intro.import` (the owner sees it while it is off).
  const user = await authUserOrNull();
  const flags = user ? await readFlags() : {};
  const importOn = !!user && selfIntroImportOn(flags, isDev(user.email));
  // Files go to the user's file store: its gate is `import.any` (importAnyOn).
  const filesOn = !!user && importAnyOn(flags, isDev(user.email));
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <SelfIntroClient importOn={importOn} filesOn={filesOn} />
      </div>
    </div>
  );
}
