// A /vibe doc's text never reaches anything shared across users (docs/vibe.md, "Where
// its text goes"): the reader's translate, word_gloss, the shared clips. Invented text
// and a stubbed model; no microphone, no audio.
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { getReadMaterialById, type ReadMaterial } from "@/lib/getReadMaterialsCollection";
import { useBackend, useBlobs, useD1 } from "./support/testMocks";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { fillGlosses, type Complete } from "@/lib/read/gloss-server";
import type { D1Batch } from "@/lib/read/reader-store";
import { speechChunks } from "@/lib/read/player";
import { translate } from "@/lib/read/translate-server";
import { linesReply, startReply, translateLineReply } from "@/lib/vibe/api";
import { isPrivateSpeech, isVibeMaterial, moreThanAWord } from "@/lib/vibe/private-speech";
import { docTranslations, translateSelection } from "@/lib/vibe/translate-server";
import { wordsTts, type WordsTtsDeps } from "@/lib/words-tts";

const T0 = 1_800_000_000_000;
const LINE = "An invented line was said. Then another invented one followed.";
const SHORT = "A short invented remark.";

let d1: TestD1Database;
let db: D1Batch;
let calls: number;
/** Every statement this test's code prepared. */
let sql: string[];

const model: Complete = async () => {
  calls++;
  return {
    choices: [{ message: { content: `une traduction ${calls}` } }],
    usage: { prompt_tokens: 90, completion_tokens: 25 },
  };
};

beforeEach(() => {
  calls = 0;
  sql = [];
  d1 = createTestD1(testSchema());
  const prepare = d1.prepare.bind(d1);
  (d1 as unknown as { prepare: (q: string) => unknown }).prepare = (q: string) => {
    sql.push(q);
    return prepare(q);
  };
  db = d1 as unknown as D1Batch;
  useD1(d1);
  useBackend("d1");
  for (const u of ["u1", "u2"])
    d1.exec(
      `INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt) VALUES ('${u}', '${u}@example.com', '${u}', 1, 0, 0)`,
    );
  const blobs = new Map<string, string>();
  useBlobs({
    put: async (k: string, v: string) => void blobs.set(k, v),
    get: async (k: string) => (blobs.has(k) ? { text: async () => blobs.get(k)! } : null),
    delete: async (k: string) => void blobs.delete(k),
  });
});

const convo = async (user = "u1", lines = [LINE, SHORT]) => {
  const id = (await startReply(db, user, { tap: true, title: "T" }, T0)).body.id as string;
  const r = await linesReply(db, user, id, { from: 0, lines }, T0);
  const material = (await getReadMaterialById(user, r.body.material as string)) as ReadMaterial;
  return { id, material };
};
const select = (m: ReadMaterial, text: string, user = "u1", to = "fr") =>
  translateSelection(db, user, m, { text, to, from: "en" }, { complete: model }, T0);
const shared = async () =>
  (await db.prepare("SELECT key FROM read_translation").bind().all()).results;

describe("the reader's translate on a /vibe doc", () => {
  it("knows the doc by the key it was saved under; an ordinary book is not one", async () => {
    const { material } = await convo();
    expect(isVibeMaterial(material)).toBe(true);
    expect(isVibeMaterial({ sourceKey: "gdoc:fake-id" })).toBe(false);
    expect(isVibeMaterial({})).toBe(false);
  });

  it("the route sends such a doc to translateSelection, and everything else to the shared path", () => {
    const route = readFileSync("app/api/read/[id]/translate/route.ts", "utf8");
    expect(route).toMatch(/isVibeMaterial\(ctx\.material\)\s*\?\s*await translateSelection\(/);
  });

  it("never touches read_translation: not read, not written", async () => {
    const { material } = await convo();
    sql.length = 0;
    await select(material, SHORT);
    await select(material, SHORT);
    await select(material, "Then another invented one followed.");
    await select(material, "invented line");
    expect(sql.join("\n")).not.toContain("read_translation");
    expect(await shared()).toEqual([]);
  });

  it("is not answered from the shared table, even when it holds this very text", async () => {
    const { material } = await convo();
    await translate(
      db,
      { text: SHORT, to: "fr", from: "en" },
      {
        userId: "u2",
        complete: async () => ({ choices: [{ message: { content: "from someone's book" } }] }),
      },
    );
    expect((await shared()).length).toBe(1);
    const r = await select(material, SHORT);
    expect(r).toEqual({ ok: true, text: "une traduction 1", cached: false });
  });

  it("a whole line uses its private row: one model call, here or from the log", async () => {
    const { id, material } = await convo();
    expect(await select(material, SHORT)).toEqual({
      ok: true,
      text: "une traduction 1",
      cached: false,
    });
    expect(await select(material, `  ${SHORT} `)).toEqual({
      ok: true,
      text: "une traduction 1",
      cached: true,
    });
    const log = await translateLineReply(
      db,
      "u1",
      id,
      { text: SHORT, to: "fr", from: "en" },
      T0,
      model,
    );
    expect(log.body).toEqual({ text: "une traduction 1", cached: true });
    expect(calls).toBe(1);
  });

  it("a line the log translated answers the selection with no model", async () => {
    const { id, material } = await convo();
    await translateLineReply(db, "u1", id, { text: SHORT, to: "fr", from: "en" }, T0, model);
    expect(await select(material, SHORT)).toMatchObject({ cached: true });
    expect(calls).toBe(1);
  });

  it("a piece of a line is translated and stored nowhere", async () => {
    const { id, material } = await convo();
    const a = await select(material, "Then another invented one followed.");
    const b = await select(material, "Then another invented one followed.");
    expect(a).toMatchObject({ ok: true, cached: false });
    expect(b).toMatchObject({ ok: true, cached: false });
    expect(calls).toBe(2);
    expect(await docTranslations(db, id)).toEqual([]);
    expect(await shared()).toEqual([]);
  });

  it("a second account gets nothing", async () => {
    const { material } = await convo("u1");
    await select(material, SHORT);
    expect(calls).toBe(1);
    // The route's gate: the material is not theirs, so it answers 404 before anything.
    expect(await getReadMaterialById("u2", String(material._id))).toBeNull();
    // Past that gate anyway: the doc is asked for under their id, so no row is read.
    const stolen = await select(material, SHORT, "u2");
    expect(stolen).toMatchObject({ text: "une traduction 2", cached: false });
    // The same words in their own book or their own conversation: their own answer.
    const own = await convo("u2");
    expect(await select(own.material, SHORT, "u2")).toMatchObject({
      text: "une traduction 3",
      cached: false,
    });
    const book = await translate(
      db,
      { text: SHORT, to: "fr", from: "en" },
      { userId: "u2", complete: model },
    );
    expect(book).toMatchObject({ text: "une traduction 4", cached: false });
  });

  it("a doc with no vibe_doc row stores nothing rather than guess", async () => {
    const { id, material } = await convo();
    await db.prepare("DELETE FROM vibe_doc WHERE id = ?").bind(id).run();
    await select(material, SHORT);
    expect(await shared()).toEqual([]);
    expect((await db.prepare("SELECT doc_id FROM vibe_translation").bind().all()).results).toEqual(
      [],
    );
  });

  it("an ordinary book still uses the shared cache", async () => {
    const input = { text: SHORT, to: "fr", from: "en" };
    const a = await translate(db, input, { userId: "u1", complete: model });
    const b = await translate(db, input, { userId: "u2", complete: model });
    expect(a).toMatchObject({ cached: false });
    expect(b).toMatchObject({ text: "une traduction 1", cached: true });
    expect((await shared()).length).toBe(1);
  });
});

describe("word_gloss", () => {
  const glossModel: Complete = async (body) => {
    calls++;
    const asked = JSON.parse((body.messages as { content: string }[])[1].content) as {
      word: string;
    }[];
    return {
      choices: [
        {
          message: {
            content: JSON.stringify(
              Object.fromEntries(asked.map((x) => [x.word, "invented meaning"])),
            ),
          },
        },
      ],
    };
  };
  const rows = async () =>
    (
      await db.prepare("SELECT term FROM word_gloss ORDER BY term").bind().all<{ term: string }>()
    ).results.map((r) => r.term);
  const book = (privateText: boolean) => ({ hash: "h", title: "T", lang: "en", privateText });
  const ai = { userId: "u1", complete: glossModel };

  it("a /vibe doc's phrase gets its meaning but stays out of the shared table", async () => {
    const [x] = await fillGlosses(db, book(true), [{ w: "invented line was said" }], ai);
    expect(x.back).toBe("invented meaning");
    expect(await rows()).toEqual([]);
  });

  it("a single word of it is written: a headword and its gloss, no sentence", async () => {
    const [x] = await fillGlosses(
      db,
      book(true),
      [{ w: "zorblat", ex: "A zorblat line was said." }],
      ai,
    );
    expect(x.back).toBe("invented meaning");
    expect(await rows()).toEqual(["zorblat"]);
    const stored = await db.prepare("SELECT * FROM word_gloss").bind().first();
    expect(JSON.stringify(stored)).not.toContain("line was said");
  });

  it("an ordinary book's phrase is shared as before", async () => {
    await fillGlosses(db, book(false), [{ w: "give up" }], ai);
    expect(await rows()).toEqual(["give up"]);
  });

  it("the routes' book carries the mark", () => {
    expect(readFileSync("lib/read/reader-route.ts", "utf8")).toContain(
      "privateText: isVibeMaterial(ctx.material)",
    );
  });
});

describe("shared clips", () => {
  const email = "u1@example.com";

  it("two or more words, with or without spaces", () => {
    expect(moreThanAWord("hello", "en")).toBe(false);
    expect(moreThanAWord("hello there", "en")).toBe(true);
    expect(moreThanAWord("今天天气很好", "zh")).toBe(true);
    expect(moreThanAWord("hello there", "not a tag!")).toBe(true);
  });

  it("each sentence the reader would read aloud from a doc is private; to its owner only", async () => {
    const quoted = 'She said "an invented thing" there.';
    await convo("u1", [LINE, quoted]);
    for (const line of [LINE, quoted])
      for (const chunk of speechChunks(line))
        expect(await isPrivateSpeech(db, email, chunk, "en")).toBe(true);
    expect(await isPrivateSpeech(db, "u2@example.com", SHORT, "en")).toBe(false);
    expect(await isPrivateSpeech(db, email, "Words nobody here said.", "en")).toBe(false);
  });

  it("a single word of a doc is not", async () => {
    await convo();
    expect(await isPrivateSpeech(db, email, "invented", "en")).toBe(false);
  });

  const listWithExample = (src: string, ex: string) => {
    d1.exec(
      `INSERT INTO word_lists (email, id, name, lang, source, cursor, params, created_at, updated_at, position)
       VALUES ('${email}', 'l1', 'L', 'en', '${src}', 0, '{}', 'x', 'x', 0)`,
    );
    d1.exec(
      `INSERT INTO word_list_entries (email, list_id, key, position, term, back, ex, updated_at)
       VALUES ('${email}', 'l1', 'k', 0, 'invented', 'made up', '${ex}', 'x')`,
    );
  };

  it("a card's example from a book list stays private after its doc is gone", async () => {
    listWithExample("book:fakehash", SHORT);
    expect(await isPrivateSpeech(db, email, SHORT, "en")).toBe(true);
  });

  it("a bundled deck's example is not", async () => {
    listWithExample("fake-deck", SHORT);
    expect(await isPrivateSpeech(db, email, SHORT, "en")).toBe(false);
  });

  const MP3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
  const tts = (isPrivate: WordsTtsDeps["isPrivate"]) => {
    const puts: string[] = [];
    const logs: string[] = [];
    const d: WordsTtsDeps = {
      getVoiceClip: async () => null,
      getCachedTTS: async () => null,
      putCachedTTS: async (k) => void puts.push(k),
      checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
      isConfigured: () => true,
      speechModel: () => "m",
      speech: async () => ({ audio: new Uint8Array(MP3), contentType: "audio/mpeg" }),
      log: (w) => void logs.push(w),
      isPrivate,
    };
    return { d, puts, logs };
  };
  const q = new URLSearchParams({ lang: "en", text: SHORT });

  it("a private sentence is voiced, not kept, and nobody's cache holds it", async () => {
    const t = tts(async () => true);
    const r = await wordsTts(q, email, t.d);
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(t.puts).toEqual([]);
  });

  it("an unknown answer counts as private", async () => {
    const t = tts(async () => {
      throw new Error("down");
    });
    const r = await wordsTts(q, email, t.d);
    expect(r.status).toBe(200);
    expect(t.puts).toEqual([]);
    expect(t.logs).toEqual(["words.tts.private"]);
  });

  it("anything else is kept, as before", async () => {
    const t = tts(async () => false);
    const r = await wordsTts(q, email, t.d);
    expect(r.headers.get("Cache-Control")).toContain("max-age");
    expect(t.puts.length).toBe(1);
  });

  it("the route asks", () => {
    expect(readFileSync("app/api/words/tts/route.ts", "utf8")).toContain("isPrivateSpeech(getD1()");
  });
});
