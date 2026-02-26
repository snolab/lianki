import type { Metadata } from "next";
import { authEmail, authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { getLocale } from "next-intlayer/server";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import LearnClient from "./LearnClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: "Learn - Lianki",
    description: "Import materials from recommended lists, YouTube playlists, or custom URLs",
    ...generateHreflangMetadata(locale, "/learn"),
  };
}

export default async function LearnPage() {
  const email = await authEmail();
  const user = await authUser();
  const locale = await getLocale();
  const { appName, nav } = getIntlayer("landing-page", locale);

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
        <LearnClient locale={locale} />
      </main>
    </div>
  );
}
