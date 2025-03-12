import Image from "next/image";
import { Suspense } from "react";
import { sf } from "sflow";
import { ems } from "./ems";
import { getFSRSNotesCollection } from "./getFSRSNotesCollection";
import { authEmail, authUser } from "./signInEmail";
export const dynamic = "force-dynamic";
/**
 * @author: snomiao <snomiao@gmail.com>
 */
export default async function HomePage() {
  const email = await authEmail();
  const user = await authUser()
  const FSRSNotes = getFSRSNotesCollection(email);
  return (
    <div>
      <nav><ul>
        <li>
          <a href='./fsrsnext.user.js'>Install user script</a>
        </li>
        <li>
          <summary>
            {user.image && <Image className='w-4 h-4' alt='avater' src={user.image} />}
            <details><ul>
              <li>
                <a>{email}</a></li>
              <li>
                <a href='/api/auth/signout'>Sign out</a></li></ul>
            </details>
          </summary>
        </li>
      </ul></nav>
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
        <Suspense>
          {FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } })}
        </Suspense>
      </p>
      <ul>
        <Suspense>
          <Cards />
        </Suspense>w
      </ul>
    </div>
  );
  async function Cards({ page = 0, size = 100 }) {
    const email = await authEmail();
    const FSRSNotes = getFSRSNotesCollection(email);
    return (
      <>
        <Suspense>
          {(async function () {
            // "use server";
            return sf(
              FSRSNotes.find({}, { sort: { "card.due": 1 } })
                .skip(page * size)
                .limit(size)
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
