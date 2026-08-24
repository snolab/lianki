import type { Metadata } from "next";
import { authEmail, authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { Header } from "@/app/components/Header";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import PreferencesClient from "./PreferencesClient";
import { appLocale } from "@/lib/app-locale.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("preferences-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/preferences"),
  };
}

export default async function PreferencesPage() {
  const email = await authEmail();
  const user = await authUser();
  const locale = await appLocale();
  const { appName, nav } = getIntlayer("landing-page", locale);

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        importLabel={nav.import}
        aiVocabLabel={nav.aiVocab}
        signInLabel={nav.signIn}
        dashboardLabel={nav.dashboard}
        profileLabel={nav.profile}
        preferencesLabel={nav.preferences}
        membershipLabel={nav.membership}
        signOutLabel={nav.signOut}
        user={user}
      />

      {/* Main Content */}
      <main className="flex-grow">
        <PreferencesClient />
      </main>
    </div>
  );
}
