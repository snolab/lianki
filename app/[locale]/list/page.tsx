import Image from "next/image";
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
import { getIntlayer } from "intlayer";
import { getLocale } from "next-intlayer/server";
import { LanguageSwitcher } from "@/app/components/LanguageSwitcher";
import { generateHreflangMetadata } from "@/lib/hreflang";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: "Lianki - Learning Dashboard",
    description: "Manage your flashcards and track your learning progress",
    ...generateHreflangMetadata(locale, "/list"),
  };
}
/**
 * @author: snomiao <snomiao@gmail.com>
 */
export default async function HomePage() {
  const email = await authEmail();
  const user = await authUser();
  const FSRSNotes = getFSRSNotesCollection(email);
  const locale = await getLocale();
  const { appName, nav } = getIntlayer("landing-page", locale);

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="py-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between">
          <a href={`/${locale}`} className="text-2xl font-bold hover:underline">
            {appName}
          </a>
          <nav className="flex items-center gap-6">
            <a href={`/${locale}/blog`} className="text-lg font-medium hover:underline">
              {nav.blog}
            </a>
            <a href={`/${locale}/polyglot`} className="text-lg font-medium hover:underline">
              Polyglot
            </a>
            <a href="./lianki.user.js" className="text-lg font-medium hover:underline">
              Install
            </a>
            <LanguageSwitcher />
            <div className="relative group">
              <button className="flex items-center gap-2 text-lg font-medium hover:underline">
                {user.image && (
                  <Image
                    className="w-6 h-6 rounded-full"
                    alt="avatar"
                    src={user.image}
                    width={24}
                    height={24}
                  />
                )}
                <span>{user.name}</span>
              </button>
              <div className="hidden group-hover:block absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded-md shadow-lg py-1 z-10">
                <a
                  href={`/${locale}/profile`}
                  className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  Profile
                </a>
                <a
                  href={`/${locale}/preferences`}
                  className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  Preferences
                </a>
                <a
                  href={`/${locale}/membership`}
                  className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  Membership
                </a>
                <div className="block px-4 py-2 text-sm text-gray-500">{email}</div>
                <a
                  href="/auth/logout"
                  className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  Sign out
                </a>
              </div>
            </div>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="mb-6">
            <a
              href="/next"
              className="bg-blue-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-blue-700"
              accessKey="1"
            >
              Next card
            </a>
          </div>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <p className="text-lg">
              Total cards: <Suspense>{FSRSNotes.countDocuments({})}</Suspense>
            </p>
            <p className="text-lg">
              Due cards:{" "}
              <Suspense>{FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } })}</Suspense>
            </p>
          </div>
          <section className="my-8">
            <div className="flex items-center mb-4">
              <h2 className="text-xl font-semibold">Learning Activity</h2>
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
          <ul className="space-y-2">
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
                  <li key={note._id.toString()}>
                    {due} <ReviewHistory logs={logs} /> <a href={url}>{title || url}</a>
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
function dueMs(due: Date) {
  return ems(+due - +new Date(), {
    shortFormat: true,
    roundUp: true,
  });
}
