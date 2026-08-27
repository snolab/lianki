import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import PolyglotClient from "./PolyglotClient";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("polyglot-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/polyglot"),
  };
}

export default async function PolyglotPage() {
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <PolyglotClient />
      </div>
    </div>
  );
}
