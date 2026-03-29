import { readFileSync } from "fs";
import { join } from "path";
import type { WithId } from "mongodb";
import DIE from "phpdie";
import { sflow, TextEncoderStream } from "sflow";
import {
  type Card,
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Grade,
  Rating,
  RecordLogItem,
  type ReviewLog,
} from "ts-fsrs";
import { z } from "zod";
import { revalidateTag } from "next/cache";
import { dueMs } from "./ems";
import { buildNextDueQuery, compareHLC, type HLC, newServerHLC, RATING_MAP } from "./fsrs-helpers";
import { getFSRSNotesCollection } from "./getFSRSNotesCollection";
import { getHeatmapCacheTag } from "./lib/heatmap-cache";
import { normalizeUrl } from "@/lib/normalizeUrl";

const LIANKI_USERSCRIPT_VERSION = (() => {
  try {
    const src = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf8");
    return src.match(/@version\s+([\d.]+)/)?.[1] ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export type { HLC } from "./fsrs-helpers";

export type FSRSNote = {
  url: string;
  title?: string;
  card: Card;
  log?: ReviewLog[]; // Review history
  notes?: string; // User notes, max 128 chars
  speedMarkers?: Record<number, number>; // {timestamp: speed}
  hlc?: HLC; // Hybrid Logical Clock for sync
  deviceId?: string; // Last device that modified (legacy field)
};

// Configure FSRS with fuzz enabled to prevent review bunching
// Fuzz adds small random variations (±2.5% by default) to scheduled intervals
// This prevents cards added on the same day from all being due at the exact same time
const fsrsConfig = fsrs(
  generatorParameters({
    enable_fuzz: true, // Explicitly enable fuzz (default is true, but making it explicit)
  }),
);

function nextDueQuery(req: Request, excludeUrl?: string) {
  const url = new URL(req.url, "http://localhost");
  const excludeDomains = url.searchParams.get("excludeDomains")?.split(",").filter(Boolean) ?? [];
  // Allow excludeUrl from query param as fallback (used by next-url endpoint)
  const exclude = excludeUrl ?? url.searchParams.get("excludeUrl") ?? undefined;
  return buildNextDueQuery(excludeDomains, exclude);
}

export const fsrsHandler = async (req: Request, email?: string) => {
  const FSRSNotes = getFSRSNotesCollection(email);

  type RegexRoutes = Record<
    string,
    (req: Request, options: { params: Record<string, string> }) => Promise<Response>
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
        sflow(FSRSNotes.find({ "card.due": { $lte: new Date() } }, { sort: { "card.due": 1 } }))
          .map((note) => `window.open(${JSON.stringify(note.url)})`)
          .onFlush((c) =>
            c.enqueue("window.close(); alert('ALL REVIEWS DONE, IT s TIME TO LEARN NEW TRICKS')"),
          )
          .join("\n"),
        { headers: { "content-type": "text/html" } },
      ),
    "GET /add(?:/|$|\\?)": async (req, options) => JSONR(saveQueryNote(req, options)),
    "POST /api/fsrs/add/?$": async (req) => JSONR(saveQueryNoteByJSONData(req)),
    "POST /api/fsrs/batch-add/?$": async (req) => {
      const zBatchAddNote = z.object({
        urls: z.array(z.string()),
      });
      const input = await req.json();
      const { urls } = zBatchAddNote.parse(input);

      // Save all URLs in parallel
      const results = await Promise.allSettled(urls.map((url) => saveNote({ url })));

      const successful = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      return JSONR({
        success: true,
        count: successful,
        failed,
        total: urls.length,
      });
    },
    "GET /api/fsrs/due(?:/|$|\\?)": async (req) => {
      const url = new URL(req.url, "http://localhost");
      const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
      const excludeDomains =
        url.searchParams.get("excludeDomains")?.split(",").filter(Boolean) ?? [];

      const query: any = { "card.due": { $lte: new Date() } };
      if (excludeDomains.length > 0) {
        query.url = {
          $not: new RegExp(excludeDomains.map((d) => d.replace(/\./g, "\\.")).join("|")),
        };
      }

      const cards = await FSRSNotes.find(query, { sort: { "card.due": 1 }, limit }).toArray();

      return JSONR({
        cards: cards.map((note) => ({
          _id: note._id.toString(),
          url: note.url,
          title: note.title,
          card: note.card,
          log: note.log,
          notes: note.notes,
          hlc: note.hlc || newServerHLC(),
        })),
      });
    },
    "GET /api/fsrs/options(?:/|$|\\?)": async (req, options) => {
      const note = (await getQueryNote(req, options)) ?? DIE("note not found");
      const repeatRecord = fsrsConfig.repeat(note.card, new Date());
      return JSONR({
        id: (note as WithId<FSRSNote> & { _id: string })._id.toString(),
        options: ([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const).map(
          (rating, i) => ({
            rating,
            label: ["Again", "Hard", "Good", "Easy"][i],
            due: dueMs(repeatRecord[rating].card.due),
          }),
        ),
      });
    },
    "GET /api/fsrs/next-url(?:/|$|\\?)": async (req) => {
      const note = await FSRSNotes.findOne(nextDueQuery(req), { sort: { "card.due": 1 } });
      return JSONR({ url: note?.url ?? null, title: note?.title ?? null });
    },
    "GET /api/fsrs/review/(?<rating>1|2|3|4|again|hard|good|easy)(?:/|$|\\?)": async (
      req,
      options,
    ) => {
      const params = getParams(req, options);
      const rating = RATING_MAP[params.rating] ?? DIE("unknown rating: " + String(params.rating));
      const note = (await getQueryNote(req, options)) ?? DIE("note not found");
      const reviewedCard = await reviewed(note, rating);

      const nextNote = await FSRSNotes.findOne(nextDueQuery(req, note.url), {
        sort: { "card.due": 1 },
      });

      return JSONR({
        ok: true,
        due: dueMs(reviewedCard.card.due),
        nextUrl: nextNote?.url ?? null,
        nextTitle: nextNote?.title ?? null,
      });
    },
    "POST /api/fsrs/review/(?<rating>1|2|3|4|again|hard|good|easy)(?:/|$|\\?)": async (
      req,
      options,
    ) => {
      const params = getParams(req, options);
      const rating = RATING_MAP[params.rating] ?? DIE("unknown rating: " + String(params.rating));

      const note = (await getQueryNote(req, options)) ?? DIE("note not found");

      // Parse client HLC if provided
      const zReviewBody = z.object({
        hlc: z
          .object({
            timestamp: z.number(),
            counter: z.number(),
            deviceId: z.string(),
          })
          .optional(),
      });

      let clientHLC: HLC | undefined;
      try {
        const body = await req.json();
        const parsed = zReviewBody.parse(body);
        clientHLC = parsed.hlc;
      } catch {
        // Body is optional, continue without HLC
      }

      // Check for conflicts
      if (clientHLC && note.hlc) {
        const comparison = compareHLC(clientHLC, note.hlc);
        if (comparison < 0) {
          // Client HLC is older than server - reject update
          return JSONR(
            {
              ok: false,
              error: "conflict",
              message: "Server has newer version",
              serverHLC: note.hlc,
              card: note.card,
              log: note.log,
            },
            409,
          );
        }
      }

      const reviewedCard = await reviewed(note, rating, clientHLC);

      const nextNote = await FSRSNotes.findOne(nextDueQuery(req, note.url), {
        sort: { "card.due": 1 },
      });

      return JSONR({
        ok: true,
        due: dueMs(reviewedCard.card.due),
        card: reviewedCard.card,
        log: reviewedCard.log,
        hlc: reviewedCard.hlc,
        nextUrl: nextNote?.url ?? null,
        nextTitle: nextNote?.title ?? null,
      });
    },
    "GET /api/fsrs/delete(?:/|$|\\?)": async (req, opt) => {
      const note = (await getQueryNote(req, opt)) ?? DIE("note not found");
      await FSRSNotes.deleteOne({ url: note.url });

      const nextNote = await FSRSNotes.findOne(nextDueQuery(req), { sort: { "card.due": 1 } });

      return JSONR({
        ok: true,
        nextUrl: nextNote?.url ?? null,
        nextTitle: nextNote?.title ?? null,
      });
    },
    "PATCH /api/fsrs/notes(?:/|$|\\?)": async (req, opt) => {
      const note = (await getQueryNote(req, opt)) ?? DIE("note not found");
      const { notes } = z.object({ notes: z.string().max(128) }).parse(await req.json());
      await FSRSNotes.updateOne({ url: note.url }, { $set: { notes } });
      return JSONR({ ok: true });
    },
    "PATCH /api/fsrs/update-url(?:/|$|\\?)": async (req) => {
      const { oldUrl, newUrl } = z
        .object({ oldUrl: z.string(), newUrl: z.string() })
        .parse(await req.json());
      const result = await FSRSNotes.updateOne(
        { url: normalizeUrl(oldUrl) },
        { $set: { url: normalizeUrl(newUrl) } },
      );
      return JSONR({ ok: result.matchedCount > 0 });
    },
    "POST /api/fsrs/speed-markers(?:/|$|\\?)": async (req) => {
      const { url, markers } = z
        .object({
          url: z.string(),
          markers: z.record(z.number(), z.number()),
        })
        .parse(await req.json());
      const normalized = normalizeUrl(url);
      await FSRSNotes.updateOne(
        { url: normalized },
        { $set: { speedMarkers: markers } },
        { upsert: true },
      );
      return JSONR({ ok: true });
    },
    "GET /api/fsrs/speed-markers(?:/|$|\\?)": async (req, opts) => {
      const { url } = getParams(req, opts);
      const normalized = normalizeUrl(url);
      const note = await FSRSNotes.findOne({ url: normalized });
      return JSONR({ markers: note?.speedMarkers ?? {} });
    },
    "GET /api/fsrs/next(?:/|\\?|$)": async () =>
      new Response(
        sflow(FSRSNotes.find({ "card.due": { $lte: new Date() } }, { sort: { "card.due": 1 } }))
          .limit(1)
          .map((note) => {
            const url = JSON.stringify(note.url);
            const q = new URLSearchParams({
              id: note._id.toString(),
            }).toString();
            return `window.open(${url}); location.href='/api/fsrs/repeat/?${q}'`;
          })
          .onFlush((c) =>
            c.enqueue("window.close(); alert('ALL REVIEWS DONE, IT s TIME TO LEARN NEW TRICKS')"),
          )
          .map((script) => `<script>${script}</script>`)
          .join("\n")
          .by(new TextEncoderStream()),
        { headers: { "content-type": "text/html" } },
      ),
    // preview repeats
    "GET /api/fsrs/repeat(?:/|$|\\?)": async (req, opt) => {
      const note = (await saveQueryNote(req, opt)) ?? DIE("note not found");
      const search = new URLSearchParams({
        id: note._id.toString(),
      }).toString();
      const doctitle = `[${dueMs(note.card.due)}] ${note.title ?? note.url}`;
      return HTMLR(
        sflow([
          sflow(`Current due: ${dueMs(note.card.due)}`),

          sflow(`<script>document.title = ${JSON.stringify(doctitle)};</script>`),

          sflow(`<br/>`),
          sflow(Object.values(fsrsConfig.repeat(note.card, new Date())))
            .map(
              (logitem, i) =>
                `<a href="javascript:review(${i + 1})" rel="noopener noreferrer" accessKey='${
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
            async function review(rating) {
              await fetch('/api/fsrs/review/' + rating + '/?${search}');
              location.href = '/api/fsrs/next';
            }
            async function deleteCard() {
              await fetch('/api/fsrs/delete/?${search}');
              location.href = '/api/fsrs/next';
            }
            addEventListener('keydown', (e) => {
              if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
              // no modifier keys
              if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
              if (e.code === 'Digit1') review(1);
              if (e.code === 'Digit2') review(2);
              if (e.code === 'Digit3') review(3);
              if (e.code === 'Digit4') review(4);
              if (e.code === 'Digit5') deleteCard();

              // asdt = easy, good, again, delete
              if (e.code === 'KeyA') review(4);
              if (e.code === 'KeyS') review(3);
              if (e.code === 'KeyD') review(1);
              if (e.code === 'KeyT') deleteCard();

              // hjlm = easy, good, again, delete
              if (e.code === 'KeyH') review(4);
              if (e.code === 'KeyJ') review(3);
              if (e.code === 'KeyL') review(1);
              if (e.code === 'KeyM') deleteCard();
            });
          </script>`),

          sflow(`<br/>`),
          sflow(
            `Reviewing <a target="_blank" href="${note.url}">${
              (note.title?.replace(/$/, " - ") ?? "") + note.url
            }</a>`,
          ),
          sflow("<br/>"),
          sflow(`<a href="javascript:deleteCard()" accessKey='5'> DELETE </a>`),

          sflow("<br/>"),
          sflow("Due cards:"),
          sflow(FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } })).map(String),
          sflow("<br/>"),
          sflow("Total cards:"),
          sflow(FSRSNotes.countDocuments({})).map(String),
          sflow("<br/>"),
          sflow("<br/>"),
        ]).confluenceByConcat(),
      );
    },
    // click btns
    "GET /review/(?<rating>1|2|3|4|again|hard|good|easy)(?:/|$|\\?)": async (req, options) => {
      const params = getParams(req, options);
      const rating = RATING_MAP[params.rating] ?? DIE("unknown rating: " + String(params.rating));

      const note = (await getQueryNote(req, options)) ?? DIE("note not found");
      const reviewdCard = await reviewed(note, rating);
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
    "GET /review-and-close/(?<rating>1|2|3|4|again|hard|good|easy)(?:/|$|\\?)": async (
      req,
      options,
    ) => {
      const params = getParams(req, options);
      const rating = RATING_MAP[params.rating] ?? DIE("unknown rating: " + String(params.rating));

      const note = (await getQueryNote(req, options)) ?? DIE("note not found");
      const reviewdCard = await reviewed(note, rating);
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
        }).toString()}">YES</a> <a href="/list">NO</a>`,
      );
    },
    "GET /delete(?:/|$|\\?)": async (req, opt) => {
      const note = (await getQueryNote(req, opt)) ?? DIE("fail to find note");
      await FSRSNotes.deleteOne({ url: note.url });
      return HTMLR(
        // `<script>window.open('/next', 'fsrs-reviewing');</script>\n`
        `<script>window.close();</script>\n`, // list mode
      );
    },
    "GET /delete-and-close(?:/|$|\\?)": async (req, opt) => {
      const note = (await getQueryNote(req, opt)) ?? DIE("fail to find note");
      await FSRSNotes.deleteOne({ url: note.url });
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
      sflow(FSRSNotes.countDocuments({ "card.due": { $lte: new Date() } })).map(String),
      sflow("\n"),

      sflow(FSRSNotes.find({}, { sort: { "card.due": 1 } }))
        .map(
          (note) => `${dueMs(note.card.due)} ${(note.title?.replace(/$/, " - ") ?? "") + note.url}`,
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

  async function reviewed(note: FSRSNote, grade: Grade, clientHLC?: HLC) {
    const { card, log } = fsrsConfig.repeat(note.card, new Date())[grade];
    const url = note.url;

    // Generate new server HLC
    const newHLC = clientHLC
      ? {
          // Use client HLC if newer
          timestamp: Math.max(clientHLC.timestamp, Date.now()),
          counter: clientHLC.timestamp >= Date.now() ? clientHLC.counter + 1 : 0,
          deviceId: clientHLC.deviceId,
        }
      : newServerHLC(note.hlc);

    let result;
    try {
      result = await FSRSNotes.findOneAndUpdate(
        { url },
        { $set: { card, hlc: newHLC }, $push: { log } },
        { returnDocument: "after", upsert: true },
      );
    } catch (err) {
      DIE(
        new Error(`Database update failed for review: ${url}`, {
          cause: err,
        }),
      );
    }

    if (!result) {
      DIE(`Failed to update note after review. URL: ${url}`);
    }

    // Invalidate heatmap cache after review
    if (email) {
      try {
        revalidateTag(getHeatmapCacheTag(email), "default");
      } catch (err) {
        // Log but don't fail the review on cache invalidation errors
        console.warn(`Failed to invalidate heatmap cache for ${email}:`, err);
      }
    }

    return result;
  }

  async function JSONR<T>(data: T | Promise<T>, status: number = 200) {
    return new Response(JSON.stringify(await data), {
      status,
      headers: {
        "content-type": "application/json",
        "x-lianki-version": LIANKI_USERSCRIPT_VERSION,
      },
    });
  }
  async function saveQueryNoteByJSONData(req: Request) {
    const zAddNote = z.object({
      url: z.string(),
      title: z.string().optional().nullable(),
    });
    const input = await req.json();
    const { url, title } = zAddNote.parse(input);
    const resp = await saveNote({ url, title: title ?? undefined });

    // Include review options in response to save an API call
    const repeatRecord = fsrsConfig.repeat(resp.card, new Date());
    const options = ([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const).map(
      (rating, i) => ({
        rating,
        label: ["Again", "Hard", "Good", "Easy"][i],
        due: dueMs(repeatRecord[rating].card.due),
      }),
    );

    return { ...resp, options, notes: resp.notes ?? "" };
  }
  async function saveQueryNote(req: Request, options?: { params?: Record<string, string> }) {
    const params = getParams(req, options);
    if (params.id) {
      const id = params.id;
      return await FSRSNotes.aggregate([
        { $set: { _id: { $toString: "$_id" } } },
        { $match: { _id: id } },
      ]).next();
    }
    const { url, title } = getQuery(req, options);
    return saveNote({ url, title: title ?? undefined });
  }
  async function getQueryNote(req: Request, options?: { params?: Record<string, string> }) {
    const params = getParams(req, options);
    const url = params["url"];
    const id = params["id"];

    if (!id && !url) {
      DIE("no query");
    }

    try {
      return (await FSRSNotes.aggregate([
        { $set: { _id: { $toString: "$_id" } } },
        {
          $match: id ? { _id: id } : { url: url! },
        },
      ]).next()) as WithId<FSRSNote>;
    } catch (err) {
      DIE(`Database query failed. ID: ${id || "none"}, URL: ${url || "none"}`);
    }
  }
  function getParams(req: Request, options: { params?: Record<string, string> } | undefined) {
    return Object.fromEntries([
      ...(options?.params ? Object.entries(options.params) : []),
      ...new URL(req.url).searchParams.entries(),
    ]);
  }

  function getQuery(req: Request, options: { params?: Record<string, string> } | undefined) {
    const params = getParams(req, options);
    if (!params.url) {
      DIE("no url");
    }
    return {
      url: params.url,
      title: params.title,
    };
  }

  async function saveNote({ url, title }: { url: string; title?: string }) {
    let normalized;
    try {
      normalized = normalizeUrl(url);
    } catch (err) {
      DIE(`Failed to normalize URL: ${url}`);
    }

    let result;
    try {
      result = await FSRSNotes.findOneAndUpdate(
        { url: normalized },
        {
          $setOnInsert: { card: createEmptyCard(), url: normalized, hlc: newServerHLC() },
          $set: { ...(title && { title }) },
        },
        { upsert: true, returnDocument: "after" },
      );
    } catch (err) {
      DIE(`Database operation failed for saveNote: ${normalized}`);
    }

    if (!result) {
      DIE(`Failed to save note: ${normalized}`);
    }

    return result;
  }

  const url = new URL(req.url, "http://localhost");
  const path = `${req.method} ${url.pathname}${url.search}`;
  console.log(path);
  for (const [pattern, fn] of Object.entries(routes).toReversed()) {
    const m = path.match(pattern);
    if (m)
      return fn(req, { params: m.groups ?? {} }).catch((error) => {
        return new Response(`Error: ${String(error.message ?? error)}; <a href='/'>Home</a>`, {
          status: 500,
          headers: { "Content-Type": "text/html" },
        });
      });
  }
  return new Response("404", { status: 404 });
};
