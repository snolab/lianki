import { Suspense } from "react";
import { sf } from "sflow";
import { ems } from "./ems";
import { getFSRSNotesCollection } from "./getFSRSNotesCollection";
import { authEmail } from "./signInEmail";
export const dynamic = "force-dynamic";
/**
 * @author: snomiao <snomiao@gmail.com>
 */
export default async function HomePage() {
  const email = await authEmail();
  const FSRSNotes = getFSRSNotesCollection(email);
  return (
    <div>
      <nav></nav>
      <div>
        <a href="/next" className="btn" accessKey="1">
          next card
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
        <Cards />
      </ul>
    </div>
  );
  function Cards({ page = 0, size = 1 }) {
    return (
      <>
        <Suspense>
          {(async function () {
            return sf(
              FSRSNotes.find({}, { sort: { "card.due": 1 } })
                .skip(page * size)
                .limit(size)
            )
              .map(
                (note) =>
                  `${dueMs(note.card.due)} ${
                    (note.title?.replace(/$/, " - ") ?? "") + note.url
                  }`
              )
              .map((e) => <li key={e}>{e}</li>)
              .toArray();
          })().then((list) => {
            if (!list.length) return <></>;
            return (
              <>
                {list}
                <Cards page={page + 1} />
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
