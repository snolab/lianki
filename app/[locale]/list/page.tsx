import type { Metadata } from "next";
import { Suspense } from "react";
import sflow from "sflow";
import { dueMs } from "@/app/ems";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { authEmail, authUser } from "@/app/signInEmail";
import { getCachedHeatmapData } from "@/app/lib/heatmap-cache";
import ActivityHeatmap from "./components/ActivityHeatmap";
import DeleteButton from "./components/DeleteButton";
import RefreshHeatmapButton from "./components/RefreshHeatmapButton";
import { ReviewHistory } from "./components/ReviewHistory";
import UserscriptInstallButton from "./components/UserscriptInstallButton";
import { getIntlayer } from "intlayer";
import { Header } from "@/app/components/Header";
import { generateHreflangMetadata } from "@/lib/hreflang";
import GuestListClient from "./components/GuestListClient";
import { SyncStatusBanner } from "./components/SyncStatusBanner";
import { HotkeyHelp } from "@/app/components/HotkeyHelp";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const { metadata } = getIntlayer("list-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateHreflangMetadata(locale, "/list"),
  };
}
/**
 * @author: snomiao <snomiao@gmail.com>
 */
export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  // Make auth optional for guest mode
  let email: string | null = null;
  let user = null;
  try {
    email = await authEmail();
    user = await authUser();
  } catch (e) {
    // Guest mode - will use IndexedDB
  }

  const { appName, nav } = getIntlayer("landing-page", locale);

  // If logged in, use server-side data
  if (email) {
    return <LoggedInView email={email} user={user} locale={locale} />;
  }

  // Guest mode - use client-side IndexedDB
  return <GuestView locale={locale} appName={appName} nav={nav} />;
}

async function LoggedInView({ email, user, locale }: { email: string; user: any; locale: string }) {
  const { appName, nav } = getIntlayer("landing-page", locale);
  const { nextCard, totalCards, dueCards, learningActivity } = getIntlayer("list-page", locale);

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

      {/* Main Content */}
      <main className="flex-grow px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="mb-6 flex gap-4">
            <a
              href={`/${locale}/next`}
              className="bg-blue-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-blue-700"
              accessKey="1"
            >
              {nextCard}
            </a>
            <UserscriptInstallButton locale={locale} />
          </div>
          <div className="mb-6">
            <Suspense fallback={<SyncStatusBanner mongoCount={null} />}>
              <LoggedInSyncStatus email={email} />
            </Suspense>
          </div>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <p className="text-lg">
              {totalCards}{" "}
              <Suspense>
                <TotalCount email={email} />
              </Suspense>
            </p>
            <p className="text-lg">
              {dueCards}{" "}
              <Suspense>
                <DueCount email={email} />
              </Suspense>
            </p>
          </div>
          <section className="my-8">
            <div className="flex items-center mb-4">
              <h2 className="text-xl font-semibold">{learningActivity}</h2>
              <RefreshHeatmapButton />
            </div>
            <Suspense
              fallback={
                <div className="h-32 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-md" />
              }
            >
              <HeatmapSection />
            </Suspense>
          </section>
          <ul className="space-y-2 overflow-x-hidden">
            <Suspense>
              <Cards />
            </Suspense>
          </ul>
        </div>
      </main>
      <HotkeyHelp />
    </div>
  );
  async function HeatmapSection() {
    const email = await authEmail();
    const heatmapData = await getCachedHeatmapData(email);

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);

    return <ActivityHeatmap data={heatmapData} startDate={oneYearAgo} endDate={new Date()} />;
  }
  async function Cards({ page = 0, size = 100 }) {
    const email = await authEmail();
    const FSRSNotes = getFSRSNotesCollection(email);
    const list = await sflow(
      FSRSNotes.find({ "card.due": { $exists: true } }, { sort: { "card.due": 1 } })
        .skip(page * size)
        .limit(size),
    )
      .map((note) => {
        const due = note.card?.due ? dueMs(note.card.due) : "?";
        const title = note.title;
        const url = note.url;
        // Explicitly pick only serializable fields — avoid spreading BSON types (ObjectId, Binary)
        // that may appear on subdocuments and are not transferable across the RSC→client boundary
        const logs = (note.log || []).map((l) => ({
          rating: l.rating,
          state: l.state,
          due: l.due instanceof Date ? l.due.toISOString() : String(l.due ?? ""),
          review: l.review instanceof Date ? l.review.toISOString() : String(l.review ?? ""),
          stability: l.stability,
          difficulty: l.difficulty,
          elapsed_days: l.elapsed_days,
          last_elapsed_days: l.last_elapsed_days,
          scheduled_days: l.scheduled_days,
          learning_steps: l.learning_steps,
        }));
        return (
          <li key={note._id.toString()} className="break-words overflow-hidden">
            {due} <ReviewHistory logs={logs} />{" "}
            <a href={url} className="break-all">
              {title || url}
            </a>
            <DeleteButton url={url} title={title} />
          </li>
        );
      })
      .toArray();

    if (!list.length) return null;
    return (
      <>
        {list}
        <Suspense>
          <Cards page={page + 1} />
        </Suspense>
      </>
    );
  }
}
async function TotalCount({ email }: { email: string }) {
  const FSRSNotes = getFSRSNotesCollection(email);
  return <>{await FSRSNotes.countDocuments({})}</>;
}

async function DueCount({ email }: { email: string }) {
  const FSRSNotes = getFSRSNotesCollection(email);
  return <>{await FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } })}</>;
}

async function LoggedInSyncStatus({ email }: { email: string }) {
  try {
    const FSRSNotes = getFSRSNotesCollection(email);
    const mongoCount = await FSRSNotes.countDocuments({});
    return <SyncStatusBanner mongoCount={mongoCount} />;
  } catch {
    return <SyncStatusBanner />;
  }
}

function GuestView({ locale, appName, nav }: { locale: string; appName: string; nav: any }) {
  const { nextCard } = getIntlayer("list-page", locale);

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
        user={null}
      />

      <main className="flex-grow px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="mb-6">
            <a
              href={`/${locale}/next`}
              className="bg-blue-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-blue-700"
              accessKey="1"
            >
              {nextCard}
            </a>
          </div>

          <GuestListClient locale={locale} />
        </div>
      </main>
    </div>
  );
}
