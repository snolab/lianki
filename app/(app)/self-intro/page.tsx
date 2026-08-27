import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import SelfIntroClient from "./SelfIntroClient";
import { appLocale } from "@/lib/app-locale.server";

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
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <SelfIntroClient />
      </div>
    </div>
  );
}
