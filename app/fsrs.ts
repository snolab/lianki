// import { bsonId } from 'bsonid';
// var ObjectId = require("bson-objectid");

// import { renderToString } from "react-dom/server";
// import { ObjectId } from "mongodb";
import type { WithId } from "mongodb";
// import { ObjectId } from "bson";
import DIE from "phpdie";
import { values } from "rambda";
import { sflow, TextEncoderStream } from "sflow";
import {
  type Card,
  createEmptyCard,
  fsrs,
  type Grade,
  Rating,
  RecordLogItem,
} from "ts-fsrs";
import { z } from "zod";
import { ems } from "./ems";
import { getFSRSNotesCollection } from "./getFSRSNotesCollection";
export type FSRSNote = {
  url: string;
  title?: string;
  card: Card;
};

// export const runtime = "edge";
// if (import.meta.main) {
//   // // 2024-08-19 easy https://www.youtube.com/watch?v=iWbKrq-oEJo&list=TLPQMTkwODIwMjSoskG2PYr69Q&index=18
//   // const url =
//   //   "https://www.youtube.com/watch?v=iWbKrq-oEJo&list=TLPQMTkwODIwMjSoskG2PYr69Q&index=18";
//   // // const note = {url: url, card: createEmptyCard()}
//   // //   console.log(createEmptyCard())
//   // const note = await saveNote({ url });
//   // console.log(fsrs().repeat(note.card, new Date())[4]);
//   console.log(renderToString("hello"));
// }

// migrate

// "FSRSNotes","FSRSNotes@670cb38bd6d5a0afbbf199ba"

export const fsrsHandler = async (req: Request, email?: string) => {
  // console.log({ userId });
  // await db.collection("FSRSNotes").rename("FSRSNotes@670cb38bd6d5a0afbbf199ba");
  const FSRSNotes = getFSRSNotesCollection(email);

  type RegexRoutes = Record<
    string,
    (
      req: Request,
      options: { params: Record<string, string> },
    ) => Promise<Response>
  >;

  const routes: RegexRoutes = {
    // due cards
    "GET /$": async () =>
      HTMLR(
        sflow([
          sflow(`
<a href='/next'>next</a>
<a href='/all'>all</a>
`),
          notesPreviewFlow(),
        ]).confluenceByConcat(),
      ),
    "GET /all$": async () =>
      new Response(
        sflow(
          FSRSNotes.find(
            { "card.due": { $lte: new Date() } },
            { sort: { "card.due": 1 } },
          ),
        )
          .map((note) => `window.open(${JSON.stringify(note.url)})`)
          .onFlush((c) =>
            c.enqueue(
              "window.close(); alert('ALL REVIEWS DONE, IT s TIME TO LEARN NEW TRICKS')",
            ),
          )
          // .map((script) => `<script>${script}</script>`)
          // .forEach(() => sleep(1000))
          .join("\n"),
        { headers: { "content-type": "text/html" } },
      ),
    "GET /add(?:/|$|\\?)": async (req, options) =>
      JSONR(saveQueryNote(req, options)),
    "POST /api/fsrs/add/?$": async (req) => JSONR(saveQueryNoteByJSONData(req)),
    "GET /next": async () =>
      new Response(
        sflow(
          FSRSNotes.find(
            {
              "card.due": { $lte: new Date() },
              url: /brainstorm|JLPT|japanese|n2|n1|n3/i,
            },
            { sort: { "card.due": 1 } },
          ),
          FSRSNotes.find(
            { "card.due": { $lte: new Date() } },
            { sort: { "card.due": 1 } },
          ),
        )
          .limit(1)
          .map((note) => {
            const url = JSON.stringify(note.url);
            const q = new URLSearchParams({
              id: note._id.toString(),
            }).toString();
            return `window.open(${url}); location.href='/repeat/?${q}'`;
          })
          .onFlush((c) =>
            c.enqueue(
              "window.close(); alert('ALL REVIEWS DONE, IT s TIME TO LEARN NEW TRICKS')",
            ),
          )
          .map((script) => `<script>${script}</script>`)
          // .forEach(() => sleep(1000))
          .join("\n")
          .by(new TextEncoderStream()),
        { headers: { "content-type": "text/html" } },
      ),
    // preview repeats
    "GET /repeat(?:/|$|\\?)": async (req, opt) => {
      const note = (await saveQueryNote(req, opt)) ?? DIE("note not found");
      const search = new URLSearchParams({
        id: note._id.toString(),
      }).toString();
      const doctitle = `[${dueMs(note.card.due)}] ${note.title ?? note.url}`;
      return HTMLR(
        sflow([
          sflow(`Current due: ${dueMs(note.card.due)}`),

          sflow(
            `<script>document.title = ${JSON.stringify(doctitle)};</script>`,
          ),

          sflow(`<br/>`),
          sflow(values(fsrs().repeat(note.card, new Date())))
            .map(
              (logitem, i) =>
                `<a href="/review/${i + 1}/?${new URLSearchParams({
                  id: note._id.toString(),
                }).toString()}" rel="noopener noreferrer" accessKey='${
                  i + 1
                }'>${["Again", "Hard", "Good", "Easy"][i]} ${dueMs(
                  (logitem as RecordLogItem).card.due,
                )}</a>`,
            )
            .join("<br/>"),
          sflow(`<br/>`),

          sflow(`
            <div>
              hotkeys: <br/>
              hjlm = easy, good, again, delete <br/>
              asdt = easy, good, again, delete <br/>
              1,2,3,4,5 = again, hard, good, easy, delete <br/>
            </div>
            <script>
            addEventListener('keydown', (e) => {
              if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
              // no modifier keys
              if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
              if (e.code === 'Digit1') location.href = '/review-and-close/1/?${search}';
              if (e.code === 'Digit2') location.href = '/review-and-close/2/?${search}';
              if (e.code === 'Digit3') location.href = '/review-and-close/3/?${search}';
              if (e.code === 'Digit4') location.href = '/review-and-close/4/?${search}';
              if (e.code === 'Digit5') location.href = '/delete-and-close/?${search}';

              // asdt = easy, good, again, delete
              if (e.code === 'KeyA') location.href = '/review/4/?${search}';
              if (e.code === 'KeyS') location.href = '/review/3/?${search}';
              if (e.code === 'KeyD') location.href = '/review/1/?${search}';
              if (e.code === 'KeyT') location.href = '/delete/?${search}';

              // hjlm = easy, good, again, delete
              if (e.code === 'KeyH') location.href = '/review-and-close/4/?${search}';
              if (e.code === 'KeyJ') location.href = '/review-and-close/3/?${search}';
              if (e.code === 'KeyL') location.href = '/review-and-close/1/?${search}';
              if (e.code === 'KeyM') location.href = '/delete-and-close/?${search}';
            });
          </script>`),

          sflow(`<br/>`),
          sflow(
            `Reviewing <a target="_blank" href="${note.url}">${
              (note.title?.replace(/$/, " - ") ?? "") + note.url
            }</a>`,
          ),
          // sflow(
          //   `<a href="/delete-confirm/?url=${encodeURIComponent(
          //     note.url
          //   )}">DELETE NOTE</a>`
          // ),
          sflow("<br/>"),
          sflow(
            `<a href="/delete/?${new URLSearchParams({
              id: note._id.toString(),
            }).toString()}" accessKey='5'> DELETE </a>`,
          ),

          sflow("<br/>"),
          sflow("Due cards:"),
          sflow(
            FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } }),
          ).map(String),
          sflow("<br/>"),
          sflow("Total cards:"),
          sflow(FSRSNotes.countDocuments({})).map(String),
          sflow("<br/>"),
          sflow("<br/>"),
        ]).confluenceByConcat(),
      );
    },
    // click btns
    "GET /review/(?<rating>1|2|3|4|again|hard|good|easy)(?:/|$|\\?)": async (
      req,
      options,
    ) => {
      const params = getParams(req, options);
      const rating =
        {
          "1": Rating.Again,
          again: Rating.Again,
          "2": Rating.Hard,
          hard: Rating.Hard,
          "3": Rating.Good,
          good: Rating.Good,
          "4": Rating.Easy,
          easy: Rating.Easy,
        }[params.rating] ?? DIE("unknown rating: " + String(params.rating));

      const reviewdCard = await reviewed(
        (await getQueryNote(req, options)) ?? DIE("fail to find note"),
        rating as Grade,
      );
      const due = dueMs(reviewdCard.card.due);
      return HTMLR(
        sflow(
          [
            `Reviewed, Next review after ${due}<br/><br/>\n`,
            `<a href="/next" autofocus>Next Card</a><br/>\n`,
            `<script>window.open('/next', 'fsrs-reviewing');</script>\n`,
          ],
          notesPreviewFlow(),
        ),
      );
    },
    "GET /review-and-close/(?<rating>1|2|3|4|again|hard|good|easy)(?:/|$|\\?)":
      async (req, options) => {
        const params = getParams(req, options);
        const rating =
          {
            "1": Rating.Again,
            again: Rating.Again,
            "2": Rating.Hard,
            hard: Rating.Hard,
            "3": Rating.Good,
            good: Rating.Good,
            "4": Rating.Easy,
            easy: Rating.Easy,
          }[params.rating] ?? DIE("unknown rating: " + String(params.rating));

        const reviewdCard = await reviewed(
          (await getQueryNote(req, options)) ?? DIE("fail to find note"),
          rating as Grade,
        );
        const due = dueMs(reviewdCard.card.due);
        return HTMLR(
          sflow(
            [
              `Reviewed, Next review after ${due}<br/><br/>\n`,
              `<a href="/next" autofocus accessKey='1'>Next Card</a><br/>\n`,
              `<script>window.close();</script>\n`,
            ],
            notesPreviewFlow(),
          ),
        );
      },
    "GET /delete-confirm(?:/|$|\\?)": async (req, opt) => {
      const note = (await getQueryNote(req, opt)) ?? DIE("fail to find note");
      return HTMLR(
        `Are you sure you want to delete <a href="${note.url}">${
          note.url
        }</a>?<br/><a href="/delete/?${new URLSearchParams({
          // url: note.url,
          id: note._id.toString(),
        }).toString()}">YES</a> <a href="/">NO</a>`,
      );
    },
    "GET /delete(?:/|$|\\?)": async (req, opt) => {
      const note = (await getQueryNote(req, opt)) ?? DIE("fail to find note");
      console.log(await FSRSNotes.deleteOne({ url: note.url }));
      return HTMLR(
        // `<script>window.open('/next', 'fsrs-reviewing');</script>\n`
        `<script>window.close();</script>\n`, // list mode
      );
    },
    "GET /delete-and-close(?:/|$|\\?)": async (req, opt) => {
      const note = (await getQueryNote(req, opt)) ?? DIE("fail to find note");
      console.log(await FSRSNotes.deleteOne({ url: note.url }));
      return HTMLR(`<script>window.close();</script>\n`);
    },
  };

  function notesPreviewFlow(): sflow<string> {
    return sflow(
      sflow(`<pre>\n`),

      sflow("Total cards:"),
      sflow(FSRSNotes.countDocuments({})).map(String),
      sflow("\n"),

      sflow("Due cards:"),
      sflow(FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } })).map(
        String,
      ),
      sflow("\n"),

      sflow(FSRSNotes.find({}, { sort: { "card.due": 1 } }))
        .map(
          (note) =>
            `${dueMs(note.card.due)} ${
              (note.title?.replace(/$/, " - ") ?? "") + note.url
            }`,
        )
        .join("\n"),
      sflow("\n"),

      sflow(`</pre>\n`),
    );
  }

  function HTMLR(html: BodyInit): Response | PromiseLike<Response> {
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  // function JSXR(el: ReactNode): Response | PromiseLike<Response> {
  //   return new Response(renderToString(el), {
  //     headers: { "content-type": "text/html" },
  //   });
  // }

  async function reviewed(note: FSRSNote, grade: Grade) {
    const { card, log } = fsrs().repeat(note.card, new Date())[grade];
    const url = note.url;
    return (await FSRSNotes.findOneAndUpdate(
      { url },
      { $set: { card }, $push: { log } },
      { returnDocument: "after", upsert: true },
    ))!;
  }

  async function JSONR<T>(data: T | Promise<T>) {
    return new Response(JSON.stringify(await data), {
      headers: { "content-type": "application/json" },
    });
  }
  async function saveQueryNoteByJSONData(req: Request) {
    const zAddNote = z.object({
      url: z.string(),
      title: z.string().optional().nullable(),
    });
    const input = await req.json();
    // const zUpdateNote = z.object({ id: z.string() });
    console.log({ input });
    const { url, title } = zAddNote.parse(input);
    const resp = await saveNote({ url, title: title ?? undefined });
    console.log({ resp });
    return resp;
  }
  async function saveQueryNote(
    req: Request,
    options?: { params?: Record<string, string> },
  ) {
    const params = getParams(req, options);
    if (params.id) {
      const id = params.id;
      // const _id = new ObjectId(id);
      // const _id = bsonId(  id );
      // const _id = { $objectId: id };
      return await FSRSNotes.aggregate([
        { $set: { _id: { $toString: "$_id" } } },
        { $match: { _id: id } },
      ]).next();
    }
    const { url, title } = getQuery(req, options);
    return saveNote({ url, title: title ?? undefined });
  }
  async function getQueryNote(
    req: Request,
    options?: { params?: Record<string, string> },
  ) {
    const params = getParams(req, options);
    const url = params["url"];
    const id = params["id"];
    return (await FSRSNotes.aggregate([
      { $set: { _id: { $toString: "$_id" } } },
      {
        $match: id
          ? (function () {
              // const _id = { $objectId: id };
              // const _id = new ObjectId(id);
              // const _id = bsonId(  id );
              return { _id: id };
            })()
          : url
            ? { url }
            : DIE("no query"),
      },
    ]).next()) as WithId<FSRSNote>;
  }
  function getParams(
    req: Request,
    options: { params?: Record<string, string> } | undefined,
  ) {
    return Object.fromEntries([
      ...(options?.params ? Object.entries(options.params) : []),
      ...new URL(req.url).searchParams.entries(),
    ]);
  }

  function getQuery(
    req: Request,
    options: { params?: Record<string, string> } | undefined,
  ) {
    const params = getParams(req, options);
    return {
      url:
        params.url ??
        DIE(new Error("url not found in query", { cause: params })),
      title: params.title,
    };
  }

  async function saveNote({ url, title }: { url: string; title?: string }) {
    return (
      (await FSRSNotes.findOneAndUpdate(
        { url },
        {
          $setOnInsert: { card: createEmptyCard() },
          $set: { ...(title && { title }) },
        },
        { upsert: true, returnDocument: "after" },
      )) ?? DIE("fail to find or create note")
    );
  }

  const url = new URL(req.url, "http://localhost");
  const path = `${req.method} ${url.pathname}${url.search}`;
  console.log(path);
  for (const [pattern, fn] of Object.entries(routes).toReversed()) {
    const m = path.match(pattern);
    if (m)
      return fn(req, { params: m.groups ?? {} }).catch((error) => {
        return new Response(
          `Error: ${String(error.message ?? error)}; <a href='/'>Home</a>`,
          {
            status: 500,
            headers: { "Content-Type": "text/html" },
          },
        );
      });
  }
  return new Response("404", { status: 404 });
};

function dueMs(due: Date) {
  return ems(+due - +new Date(), {
    shortFormat: true,
    roundUp: true,
  });
}
