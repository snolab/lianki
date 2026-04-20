import type { Metadata } from "next";
import { authUser } from "@/app/signInEmail";
import { getIntlayer } from "intlayer";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import MembershipClient from "./MembershipClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: "Membership - Lianki",
    description: "Manage your Lianki membership and view available features",
    ...generateHreflangMetadata(locale, "/membership"),
  };
}

export default async function MembershipPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
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
        user={user}
      />

      <main className="flex-grow">
        <MembershipClient />
      </main>
    </div>
  );
}
