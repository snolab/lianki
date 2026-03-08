import type { Metadata } from "next";
import { authEmail, authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { Header } from "@/app/components/Header";
import { generateHreflangMetadata } from "@/lib/hreflang";
import PreferencesClient from "./PreferencesClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const { metadata } = getIntlayer("preferences-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateHreflangMetadata(locale, "/preferences"),
  };
}

export default async function PreferencesPage({ params }: { params: Promise<{ locale: string }> }) {
  const email = await authEmail();
  const user = await authUser();
  const { locale } = await params;
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

      {/* Main Content */}
      <main className="flex-grow">
        <PreferencesClient />
      </main>
    </div>
  );
}
