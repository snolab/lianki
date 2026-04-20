import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import SignInClient from "./SignInClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const { metadata } = getIntlayer("sign-in-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateHreflangMetadata(locale, "/sign-in"),
  };
}

export default async function SignInPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const { appName, nav } = getIntlayer("landing-page", locale);

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        importLabel={nav.import}
        aiVocabLabel={nav.aiVocab}
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
        user={null}
      />

      <main className="flex-grow">
        <SignInClient />
      </main>
    </div>
  );
}
