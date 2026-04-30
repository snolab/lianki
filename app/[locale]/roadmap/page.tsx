import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import type { Locale } from "intlayer";
import { Header } from "@/app/components/Header";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { authUserOrNull } from "@/app/signInEmail";
import { redirect } from "next/navigation";
import RoadmapClient from "./components/RoadmapClient";
import { getRoadmapGoalsCollection } from "@/app/getRoadmapGoalsCollection";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: "Learning Roadmap — Lianki",
    description: "AI-generated learning roadmaps with spaced repetition progress tracking",
    ...generateHreflangMetadata(locale, "/roadmap"),
  };
}

export default async function RoadmapPage({ params }: Props) {
  const { locale } = await params;
  const { appName, nav } = getIntlayer("landing-page", locale as Locale);

  const user = await authUserOrNull();
  if (!user?.email) {
    redirect(`/${locale}/list`);
  }

  const email = user.email;
  const collection = getRoadmapGoalsCollection(email);
  const goals = await collection.find({}).sort({ updatedAt: -1 }).toArray();
  const serialized = JSON.parse(JSON.stringify(goals));

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        locale={locale}
        appName={appName}
        blogLabel={nav.blog}
        learnLabel={nav.learn}
        importLabel={nav.import}
        aiVocabLabel={nav.aiVocab}
        roadmapLabel={nav.roadmap}
        signInLabel={nav.signIn}
        dashboardLabel={nav.dashboard}
        profileLabel={nav.profile}
        preferencesLabel={nav.preferences}
        membershipLabel={nav.membership}
        signOutLabel={nav.signOut}
        user={user}
      />
      <main className="flex-grow">
        <RoadmapClient locale={locale} initialGoals={serialized} />
      </main>
    </div>
  );
}
