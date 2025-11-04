import Image from "next/image";
import { Suspense } from "react";
import sflow from "sflow";
import { ems } from "./ems";
import { getFSRSNotesCollection } from "./getFSRSNotesCollection";
import { authEmail, authUser } from "./signInEmail";
export const dynamic = "force-dynamic";
/**
 * @author: snomiao <snomiao@gmail.com>
 */
export default async function HomePage() {
  const email = await authEmail();
  const user = await authUser();
  const FSRSNotes = await getFSRSNotesCollection(email);
  return (
    <div>
      <nav>
        <ul>
          <li>
            <a href="./fsrsnext.user.js">Install user script</a>
          </li>
          <li>
            <summary>
              <span>
                {user.image && (
                  <Image alt="avater" className="w-4 h-4" src={user.image} />
                )}
                <span>{user.name}</span>
              </span>
              <details>
                <ul>
                  <li>
                    <a href="/profile">Profile</a>
                  </li>
                  <li>
                    <span>{email}</span>
                  </li>
                  <li>
                    <a href="/api/auth/signout">Sign out</a>
                  </li>
                </ul>
              </details>
            </summary>
          </li>
        </ul>
      </nav>
      <div>
        <a className="btn" href="/next">
          Next card
        </a>
      </div>
      <p>
        Total cards: <Suspense>{FSRSNotes.countDocuments({})}</Suspense>
      </p>
      <p>
        Due cards:{" "}
        <Suspense>
          {FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } })}
        </Suspense>
      </p>
      <ul>
        <Suspense>
          <Cards />
        </Suspense>
        w
      </ul>
    </div>
  );
  async function Cards({ page = 0, size = 100 }) {
    const email = await authEmail();
    const FSRSNotes = await getFSRSNotesCollection(email);
    return (
      <Suspense>
        {(async () => {
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
          if (!list.length) return null;
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
    );
  }
}
function dueMs(due: Date) {
  return ems(+due - Date.now(), {
    shortFormat: true,
    roundUp: true,
  });
}
