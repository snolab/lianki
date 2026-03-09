import type { Metadata } from "next";
import { Suspense } from "react";
import sflow from "sflow";
import { ems } from "@/app/ems";
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
  const { nextCard, totalCards, dueCards, learningActivity } = getIntlayer("list-page", locale);

  // If logged in, use server-side data
  if (email) {
    return <LoggedInView email={email} user={user} locale={locale} />;
  }

  // Guest mode - use client-side IndexedDB
  return <GuestView locale={locale} appName={appName} nav={nav} />;
}

async function LoggedInView({ email, user, locale }: { email: string; user: any; locale: string }) {
  const FSRSNotes = getFSRSNotesCollection(email);
  const { appName, nav } = getIntlayer("landing-page", locale);
  const { nextCard, totalCards, dueCards, learningActivity } = getIntlayer("list-page", locale);

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
              {totalCards} <Suspense>{FSRSNotes.countDocuments({})}</Suspense>
            </p>
            <p className="text-lg">
              {dueCards}{" "}
              <Suspense>{FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } })}</Suspense>
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
    return (
      <>
        <Suspense>
          {(async function () {
            // "use server";
            return sflow(
              FSRSNotes.find({}, { sort: { "card.due": 1 } })
                .skip(page * size)
                .limit(size),
            )
              .map((note) => {
                const due = dueMs(note.card.due);
                const title = note.title;
                const url = note.url;
                const logs = note.log || [];
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
          })().then((list) => {
            if (!list.length) return <></>;
            return (
              <>
                {list}
                <Suspense>
                  <Cards page={page + 1} />
                </Suspense>
              </>
            );
          })}
        </Suspense>
      </>
    );
  }
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

function dueMs(due: Date) {
  return ems(+due - +new Date(), "short") ?? "0s";
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
        user={null}
      />

      <main className="flex-grow px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="mb-6">
            <a
              href="/next"
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
