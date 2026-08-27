import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import LearnClient from "./LearnClient";
import { appLocale } from "@/lib/app-locale.server";
import { authEmail } from "@/app/signInEmail";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("learn-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/learn"),
  };
}

export default async function LearnPage() {
  // Auth guard, not a leftover: authEmail() redirects guests to /sign-in.
  // The value is unused — the redirect is the point.
  await authEmail();
  const locale = await appLocale();

  return (
    <div className="flex flex-col">
      <div className="flex-grow">
        <LearnClient locale={locale} />
      </div>
    </div>
  );
}
