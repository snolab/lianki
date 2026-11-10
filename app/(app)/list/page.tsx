import type { Metadata } from "next";
import { Suspense } from "react";
import { getNotesCollection } from "@/app/lib/getNotesCollection";
import { authEmail } from "@/app/signInEmail";
import { getCachedHeatmapData } from "@/app/lib/heatmap-cache";
import ActivityHeatmap from "./components/ActivityHeatmap";
import { AutoRefresh } from "./components/AutoRefresh";
import CardsList from "./components/CardsList";
import RefreshHeatmapButton from "./components/RefreshHeatmapButton";
import UserscriptInstallButton from "./components/UserscriptInstallButton";
import { getIntlayer } from "intlayer";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import GuestListClient from "./components/GuestListClient";
import { SyncStatusBanner } from "./components/SyncStatusBanner";
import { HotkeyHelp } from "@/app/components/HotkeyHelp";
import { appLocale } from "@/lib/app-locale.server";
import { LIANKI_USERSCRIPT_VERSION } from "@/lib/userscript-version";
import { titleRulesForUser } from "@/lib/titles/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const { metadata } = getIntlayer("list-page", locale);
  return {
    title: metadata.title,
    description: metadata.description,
    ...generateAppHreflangMetadata(locale, "/list"),
  };
}
/**
 * @author: snomiao <snomiao@gmail.com>
 */
export default async function HomePage() {
  const locale = await appLocale();
  // Make auth optional for guest mode
  let email: string | null = null;
  try {
    email = await authEmail();
  } catch {
    // Guest mode - will use IndexedDB
  }

  const latestVersion = LIANKI_USERSCRIPT_VERSION;

  // If logged in, use server-side data
  if (email) {
    return <LoggedInView email={email} locale={locale} latestVersion={latestVersion} />;
  }

  // Guest mode - use client-side IndexedDB
  return <GuestView locale={locale} latestVersion={latestVersion} />;
}

async function LoggedInView({
  email,
  locale,
  latestVersion,
}: {
  email: string;
  locale: string;
  latestVersion: string;
}) {
  const { nextCard, totalCards, dueCards, learningActivity } = getIntlayer("list-page", locale);

  return (
    <div className="flex flex-col">
      {/* Re-renders this server component when you come back to the tab, so a
          review done in the userscript shows up without a manual reload. */}
      <AutoRefresh />
      {/* Main Content */}
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="mb-6 flex gap-4 flex-wrap">
            <a
              href="/next"
              className="bg-blue-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-blue-700"
              accessKey="1"
            >
              {nextCard}
            </a>
            <UserscriptInstallButton locale={locale} latestVersion={latestVersion} />
            {/* Export moved to /data, alongside import, bulk delete and the
                three-store overview, so backup lives in one place. */}
            <a
              href="/data"
              className="border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-medium py-3 px-6 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Manage data
            </a>
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
          <div className="overflow-x-hidden">
            <Suspense>
              <Cards />
            </Suspense>
          </div>
        </div>
      </div>
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
  // Every card as one virtual list, more as you scroll (no pages, owner 2026-11-10).
  async function Cards() {
    return <CardsList titleRules={await titleRulesForUser()} />;
  }
}
async function TotalCount({ email }: { email: string }) {
  const FSRSNotes = getNotesCollection(email);
  return <>{await FSRSNotes.countDocuments({})}</>;
}

async function DueCount({ email }: { email: string }) {
  const FSRSNotes = getNotesCollection(email);
  return <>{await FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } })}</>;
}

async function LoggedInSyncStatus({ email }: { email: string }) {
  try {
    const FSRSNotes = getNotesCollection(email);
    const mongoCount = await FSRSNotes.countDocuments({});
    return <SyncStatusBanner mongoCount={mongoCount} />;
  } catch {
    return <SyncStatusBanner />;
  }
}

function GuestView({ locale, latestVersion }: { locale: string; latestVersion: string }) {
  const { nextCard } = getIntlayer("list-page", locale);

  return (
    <div className="flex flex-col">
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="mb-6 flex gap-4">
            <a
              href="/next"
              className="bg-blue-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-blue-700"
              accessKey="1"
            >
              {nextCard}
            </a>
            <UserscriptInstallButton locale={locale} latestVersion={latestVersion} />
          </div>

          <GuestListClient />
        </div>
      </div>
    </div>
  );
}
