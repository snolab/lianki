import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import SelfIntroClient from "./SelfIntroClient";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { selfIntroImportOn } from "@/lib/self-intro/import-handler";

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
  const importOn = !!user && selfIntroImportOn(await readFlags(), isDev(user.email));
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <SelfIntroClient importOn={importOn} />
      </div>
    </div>
  );
}
