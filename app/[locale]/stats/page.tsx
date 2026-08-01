import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { Header } from "@/app/components/Header";
import StatsClient from "./StatsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: "Input hours - Lianki",
    description: "Active listening time per video, by language, with a daily heatmap.",
    ...generateHreflangMetadata(locale, "/stats"),
  };
}

export default async function StatsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const { appName, nav } = getIntlayer("landing-page", locale);
  const user = await authUserOrNull();

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
      <main className="flex-grow">
        <StatsClient />
      </main>
    </div>
  );
}
