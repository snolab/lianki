import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import MembershipClient from "./MembershipClient";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("membership-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/membership"),
  };
}

export default async function MembershipPage() {
  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <MembershipClient />
      </div>
    </div>
  );
}
