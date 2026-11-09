import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { LEVEL_IDS } from "@/lib/levels";
import { dbBackend, getD1 } from "@/lib/d1";
import { recentStudyDays, userLevelOf, type StudyDayRow, type UserLevel } from "@/lib/study-days";
import { LevelBadge } from "@/app/components/level-badge";
import { LevelGallery, type LevelNames } from "./LevelGallery";
import { devPageText, devPageMetadata } from "../dev-page-title";

// Owner-only: his own level as the server computes it (lib/study-days.ts),
// then the gallery of the learner level badges (docs/levels.md); anyone else
// gets a plain 404. Users see their level in the nav chip and on /profile.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("levels");

function names(locale: "zh" | "en"): LevelNames {
  const d = getIntlayer("learner-levels", locale);
  return Object.fromEntries(LEVEL_IDS.map((id) => [id, String(d[id])])) as LevelNames;
}

export default async function DevLevelsPage() {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) notFound();
  const zh = names("zh");
  const en = names("en");
  let mine: { level: UserLevel; days: StudyDayRow[] } | null = null;
  let error: string | null = null;
  if (dbBackend() === "d1")
    try {
      const d1 = getD1();
      mine = {
        level: await userLevelOf(d1, user!.email),
        days: await recentStudyDays(d1, user!.email!),
      };
    } catch (e) {
      error = (e as Error).message;
    }
  const myLevel = await devPageText("myLevel");
  return (
    <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <section className="rounded-xl border border-gray-300 dark:border-gray-700 p-4 space-y-3">
        <h2 lang={myLevel.lang} className="text-lg font-semibold">
          {myLevel.text}
        </h2>
        {error && <p className="text-sm text-blue-600">{error}</p>}
        {!mine && !error && <p className="text-sm text-gray-500">D1 only.</p>}
        {mine && (
          <>
            <div className="flex items-center gap-4">
              <LevelBadge level={mine.level.level} size={96} label={en[mine.level.level]} />
              <div className="space-y-1 text-sm">
                <p className="text-xl font-semibold">
                  {zh[mine.level.level]} · {en[mine.level.level]}
                </p>
                <p>
                  {mine.level.level} · tier {mine.level.tier} · {mine.level.studyDays} study days
                </p>
                <p className="text-gray-500">
                  paid since{" "}
                  {mine.level.paidSince
                    ? new Date(mine.level.paidSince).toLocaleString("ja-JP", {
                        timeZone: "Asia/Tokyo",
                      }) + " JST"
                    : "— (never)"}
                </p>
                {mine.level.next && (
                  <p className="text-gray-500">
                    next: {zh[mine.level.next.level]} · {en[mine.level.next.level]} at{" "}
                    {mine.level.next.studyDays} days (
                    {mine.level.next.studyDays - mine.level.studyDays} to go)
                  </p>
                )}
              </div>
            </div>
            <table className="text-sm">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="pr-4">day</th>
                  <th className="pr-4">zone</th>
                  <th className="pr-4">first review (JST)</th>
                  <th>qualifying reviews</th>
                </tr>
              </thead>
              <tbody>
                {mine.days.map((d) => (
                  <tr key={d.day}>
                    <td className="pr-4">{d.day}</td>
                    <td className="pr-4">{d.tz}</td>
                    <td className="pr-4">
                      {new Date(d.first_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                    </td>
                    <td>{d.reviews}</td>
                  </tr>
                ))}
                {!mine.days.length && (
                  <tr>
                    <td colSpan={4} className="text-gray-500">
                      No study day recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </section>
      <LevelGallery zh={zh} en={en} />
    </main>
  );
}
