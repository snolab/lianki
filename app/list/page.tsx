import Image from "next/image";
import { Suspense } from "react";
import sflow from "sflow";
import { ems } from "../ems";
import { getFSRSNotesCollection } from "../getFSRSNotesCollection";
import { authEmail, authUser } from "../signInEmail";
import { getCachedHeatmapData } from "../lib/heatmap-cache";
import ActivityHeatmap from "./components/ActivityHeatmap";
export const dynamic = "force-dynamic";
/**
 * @author: snomiao <snomiao@gmail.com>
 */
export default async function HomePage() {
  const email = await authEmail();
  const user = await authUser();
  const FSRSNotes = getFSRSNotesCollection(email);
  return (
    <div>
      <nav>
        <ul>
          <li>
            <a href="./lianki.user.js">Install user script</a>
          </li>
          <li>
            <summary>
              <span>
                {user.image && <Image className="w-4 h-4" alt="avater" src={user.image} />}
                <a>{user.name}</a>
              </span>
              <details>
                <ul>
                  <li>
                    <a href="/profile">Profile</a>
                  </li>
                  <li>
                    <a>{email}</a>
                  </li>
                  <li>
                    <a href="/auth/logout">Sign out</a>
                  </li>
                </ul>
              </details>
            </summary>
          </li>
        </ul>
      </nav>
      <div>
        <a href="/next" className="btn" accessKey="1">
          Next card
        </a>
      </div>
      <p>
        Total cards: <Suspense>{FSRSNotes.countDocuments({})}</Suspense>
      </p>
      <p>
        Due cards:{" "}
        <Suspense>{FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } })}</Suspense>
      </p>
      <section className="my-8 px-4">
        <h2 className="text-xl font-semibold mb-4">Learning Activity</h2>
        <Suspense
          fallback={
            <div className="h-32 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-md" />
          }
        >
          <HeatmapSection />
        </Suspense>
      </section>
      <ul>
        <Suspense>
          <Cards />
        </Suspense>
      </ul>
    </div>
  );
  async function HeatmapSection() {
    const email = await authEmail();
    const heatmapData = await getCachedHeatmapData(email);

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setHours(0, 0, 0, 0);

    return (
      <ActivityHeatmap data={heatmapData} startDate={oneYearAgo} endDate={new Date()} />
    );
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
                return (
                  <li key={note._id.toString()}>
                    {due} <a href={url}>{title || url}</a>
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
