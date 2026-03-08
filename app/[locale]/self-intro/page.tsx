import type { Metadata } from "next";
import { authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { locale as getLocale } from "next-intlayer/server";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import SelfIntroClient from "./SelfIntroClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = getLocale;
  const { metadata } = getIntlayer("self-intro-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateHreflangMetadata(locale, "/self-intro"),
  };
}

export default async function SelfIntroPage() {
  const locale = getLocale;
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
        <SelfIntroClient />
      </main>
    </div>
  );
}
