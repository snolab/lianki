import type { Metadata } from "next";
import { authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { getLocale } from "next-intlayer/server";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import PolyglotClient from "./PolyglotClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const { metadata } = getIntlayer("polyglot-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateHreflangMetadata(locale, "/polyglot"),
  };
}

export default async function PolyglotPage() {
  const locale = await getLocale();
  const { appName, nav } = getIntlayer("landing-page", locale);

  // Try to get user if logged in
  let user = null;
  try {
    user = await authUser();
  } catch (e) {
    // User not logged in
  }

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        user={user}
      />

      <main className="flex-grow">
        <PolyglotClient />
      </main>
    </div>
  );
}
