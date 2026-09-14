import type { Metadata } from "next";
import { headers } from "next/headers";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
import { preferredImmersionLanguages } from "@/lib/immersion-sites";
import ImmersionClient from "./ImmersionClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("lab-immersion-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/lab/immersion"),
  };
}

export default async function LabImmersionPage() {
  // The browser's language list is the best first guess at which columns a
  // visitor wants; read it here so the first paint already has them.
  const preferred = preferredImmersionLanguages((await headers()).get("accept-language"));
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <ImmersionClient preferred={preferred} />
      </div>
    </div>
  );
}
