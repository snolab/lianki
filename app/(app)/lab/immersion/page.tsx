import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { appLocale } from "@/lib/app-locale.server";
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
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <ImmersionClient />
      </div>
    </div>
  );
}
