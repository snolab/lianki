/**
 * A tap on a word with no meaning asks for it (owner's card, 2026-11-06 18:18 JST:
 * 恢复，点开就查释义，要花积分): charged once through chargeAi, cached for every later
 * tap and for the commit, storing no card; the user's own AI spends nothing of ours;
 * a /vibe doc asks no model before a swipe. docs/books-plan.md, docs/byok.md, docs/vibe.md.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { ByokActive } from "@/lib/byok/config";
import { presetOf } from "@/lib/byok/presets";
import { gradeBatch, type BatchCtx } from "@/lib/read/batch-grade-server";
import type { BookCtx, RangeWord } from "@/lib/read/book-word-list";
import { glossMayAskModel } from "@/lib/read/gloss";
import { fillGlosses, type Complete } from "@/lib/read/gloss-server";
import { readerBook } from "@/lib/read/reader-book";
import type { D1Batch } from "@/lib/read/reader-store";
import type { WordContext } from "@/lib/read/reader-service";
import {
  fetchCachedGloss,
  fetchGloss,
  glossSettled,
  withTabGloss,
} from "@/lib/read/select-gloss-fetch";
import { bookHash } from "@/lib/read/units";
import { BOOK_KIND, type BookMeta } from "@/lib/read/book";

const LINES = ["Le zèbre dort.", "Un autre mot ici."];
const META: BookMeta = {
  kind: BOOK_KIND,
  v: 1,
  source: "epub",
  lang: "fr",
  chapters: [{ title: "Un", start: 0 }],
  headings: [0],
};
const EMAIL = "me@example.com";
const W: WordContext = { idx: new Map(), stats: { names: [] }, lem: null };
const NOW = new Date("2026-11-06T09:00:00Z");
const w = (x: string, more: Partial<RangeWord> = {}) => ({
  w: x,
  ex: null,
  term: null,
  reading: null,
  back: null,
  ...more,
});

let d1: TestD1Database;
let db: D1Batch;
let c: BatchCtx;
let bctx: BookCtx;
let modelCalls: number;
let charges: string[];
let logSpy: ReturnType<typeof spyOn>;

const complete: Complete = async (body) => {
  modelCalls++;
  const asked = JSON.parse((body.messages as { content: string }[])[1].content) as {
    word: string;
  }[];
  return {
    choices: [
      {
        message: {
          content: JSON.stringify(Object.fromEntries(asked.map((a) => [a.word, `m:${a.word}`]))),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  };
};
const ai = { userId: "user-a", complete };
/** What the gloss route does on a tap: `fillGlosses`, with the model or without. */
const tap = (word: string, withModel = true) =>
  fillGlosses(d1, bctx, [w(word)], withModel ? ai : null);
/** What the batch-grade route does on a commit (`own`: no model of ours). */
const commit = (id: string, word: ReturnType<typeof w>, own = false) =>
  gradeBatch(
    c,
    { clientId: id, rating: 3 },
    [word],
    NOW,
    (b) => (ws) => fillGlosses(d1, b, ws, own ? null : ai),
  );
const count = async (table: string, where = "1=1") =>
  (await d1.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
const stored = async () => ({
  lists: await count("word_lists"),
  entries: await count("word_list_entries"),
  cards: await count("word_cards"),
  reviews: await count("word_reviews"),
});
const backOf = async (term: string) =>
  (
    await d1
      .prepare("SELECT back FROM word_cards WHERE email = ? AND term = ?")
      .bind(EMAIL, term)
      .first<{ back: string }>()
  )?.back;

beforeEach(async () => {
  d1 = createTestD1(testSchema());
  db = d1 as unknown as D1Batch;
  const book = readerBook(LINES, META, await bookHash(LINES));
  bctx = { hash: book.hash, title: "Le Livre", lang: "fr", names: new Set() };
  const ref = { userId: "user-a", materialId: "mat-a", bookHash: book.hash, lang: "fr" };
  c = { db, ref, email: EMAIL, book, w: W, bctx };
  modelCalls = 0;
  charges = [];
  logSpy = spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line === "string" && line.includes('"read.gloss.cost"')) charges.push(line);
  });
});
afterEach(() => logSpy.mockRestore());

describe("a tap's meaning", () => {
  test("the first tap asks the model and charges once; repeat taps are free", async () => {
    const [first] = await tap("qazèbrex");
    expect(first.back).toBe("m:qazèbrex");
    expect(modelCalls).toBe(1);
    expect(charges).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      const [again] = await tap("qazèbrex");
      expect(again.back).toBe("m:qazèbrex");
    }
    expect(modelCalls).toBe(1);
    expect(charges).toHaveLength(1);
  });

  test("a word already in the shared cache: no model, no charge", async () => {
    await d1
      .prepare(
        "INSERT INTO word_gloss (lang, term, back, model, created_at) VALUES ('fr', 'qazèbrey', 'cached', 'm', 'now')",
      )
      .run();
    const [x] = await tap("qazèbrey");
    expect(x.back).toBe("cached");
    expect(modelCalls).toBe(0);
    expect(charges).toHaveLength(0);
  });

  test("a tap stores no card, entry or review, only the shared meaning", async () => {
    const before = await stored();
    await tap("qazèbrex");
    expect(await stored()).toEqual(before);
    expect(await count("word_gloss", "term = 'qazèbrex'")).toBe(1);
  });
});

describe("the commit after a tap", () => {
  test("reuses the tap's meaning from the shared cache: one charge in all", async () => {
    await tap("qazèbrex");
    const r = await commit("batch-tap-then-commit", w("qazèbrex"));
    if (!r.ok) throw new Error(r.error);
    expect(r.res.words).toMatchObject([{ w: "qazèbrex", made: true }]);
    expect(await backOf("qazèbrex")).toBe("m:qazèbrex");
    expect(modelCalls).toBe(1);
    expect(charges).toHaveLength(1);
  });

  test("carrying the meaning from the tab: nothing is asked either", async () => {
    await commit("batch-carried", w("qazèbrez", { term: "qazèbrez", back: "seen on the tap" }));
    expect(await backOf("qazèbrez")).toBe("seen on the tap");
    expect(modelCalls).toBe(0);
    expect(charges).toHaveLength(0);
  });

  test("no tap before it: the commit pays, once", async () => {
    await commit("batch-no-tap", w("qazèbrew"));
    expect(await backOf("qazèbrew")).toBe("m:qazèbrew");
    expect(modelCalls).toBe(1);
    expect(charges).toHaveLength(1);
  });
});

describe("the user's own AI", () => {
  const own: ByokActive = {
    backend: { provider: "openai", baseUrl: presetOf("openai")!.baseUrl, model: "m" },
    apiKey: "sk-test-not-a-real-key",
    preset: presetOf("openai")!,
  };

  test("the route asks no model of ours; the commit carries the answer, never to word_gloss", async () => {
    const [tapped] = await tap("qazèbrev", false);
    expect(tapped.back ?? null).toBeNull();
    const r = await commit(
      "batch-own",
      w("qazèbrev", { term: "qazèbrev", back: "his provider's" }),
      true,
    );
    if (!r.ok) throw new Error(r.error);
    expect(await backOf("qazèbrev")).toBe("his provider's");
    expect(modelCalls).toBe(0);
    expect(charges).toHaveLength(0);
    expect(await count("word_gloss", "term = 'qazèbrev'")).toBe(0);
  });

  test("nothing from his provider: carded without a meaning, still nothing of ours", async () => {
    const r = await commit("batch-own-none", w("qazèbreu"), true);
    if (!r.ok) throw new Error(r.error);
    expect(r.res.words).toMatchObject([{ w: "qazèbreu", made: true }]);
    expect(modelCalls).toBe(0);
    expect(charges).toHaveLength(0);
  });

  test("the tab's answers are kept per mode: own ones never pass for ours", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ term: "mot", back: "ours" }))) as unknown as typeof fetch;
    await fetchGloss("modes", "mot", null, null, { fetch: f });
    expect(withTabGloss("modes", [w("mot")], null)[0].back).toBe("ours");
    expect(withTabGloss("modes", [w("mot")], own)[0].back).toBeNull();
  });
});

describe("the tab", () => {
  const answering = (back: string | null) => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ term: "mot", back }));
    }) as unknown as typeof fetch;
    return { bodies, f };
  };

  test("a tap asks the route with the model allowed, once", async () => {
    const { bodies, f } = answering("a meaning");
    await fetchGloss("tab1", "mot", "un mot", null, { fetch: f });
    await fetchGloss("tab1", "mot", "un mot", null, { fetch: f });
    expect(bodies).toEqual([{ w: "mot", ex: "un mot" }]);
  });

  test("a commit waits for a tap still on its way, then carries its meaning", async () => {
    let answer = (_: Response) => {};
    const f = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
    const tapped = fetchGloss("tab2", "mot", null, null, { fetch: f });
    const words = [w("mot")];
    expect(withTabGloss("tab2", words, null)[0].back).toBeNull();
    let settled = false;
    const wait = glossSettled("tab2", words, null).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    answer(new Response(JSON.stringify({ term: "mot", back: "paid once" })));
    await wait;
    await tapped;
    expect(withTabGloss("tab2", words, null)[0]).toMatchObject({ term: "mot", back: "paid once" });
  });

  test("a word's own meaning is not overwritten; a word nobody asked waits for nothing", async () => {
    const { f } = answering("from the tap");
    await fetchGloss("tab3", "mot", null, null, { fetch: f });
    expect(withTabGloss("tab3", [w("mot", { back: "deck" })], null)[0].back).toBe("deck");
    expect(await glossSettled("tab3", [w("autre")], null)).toEqual([undefined]);
  });

  test("a refused route is no answer: the next tap asks again", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return n === 1
        ? new Response("{}", { status: 400 })
        : new Response(JSON.stringify({ term: "mot", back: "now" }));
    }) as unknown as typeof fetch;
    expect(await fetchGloss("tab4", "mot", null, null, { fetch: f })).toBeNull();
    expect(await fetchGloss("tab4", "mot", null, null, { fetch: f })).toMatchObject({
      back: "now",
    });
  });

  test("the live doc's own way to the route is used", async () => {
    const bodies: unknown[] = [];
    await fetchGloss("tab5", "mot", "ex", null, {
      post: async (b) => {
        bodies.push(b);
        return new Response(JSON.stringify({ term: "mot", back: "m" }));
      },
    });
    expect(bodies).toEqual([{ w: "mot", ex: "ex" }]);
  });
});

describe("a /vibe doc", () => {
  test("its fetch only ever says `cached`, and is apart from a tap's", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      bodies.push(b);
      return new Response(JSON.stringify({ term: "mot", back: b.cached ? null : "made" }));
    }) as unknown as typeof fetch;
    expect(await fetchCachedGloss("v1", "mot", "said aloud", { fetch: f })).toBeNull();
    expect(bodies).toEqual([{ w: "mot", ex: "said aloud", cached: true }]);
    await fetchCachedGloss("v1", "mot", "said aloud", { fetch: f });
    expect(bodies).toHaveLength(1);
    // "Nothing cached" did not become the answer for a tap in the same tab.
    expect(await fetchGloss("v1", "mot", null, null, { fetch: f })).toMatchObject({ back: "made" });
  });

  test("the route's rule: a vibe doc never asks the model, whatever the request says", () => {
    expect(glossMayAskModel({}, "epub")).toBe(true);
    expect(glossMayAskModel({}, undefined)).toBe(true);
    expect(glossMayAskModel({ cached: true }, "epub")).toBe(false);
    expect(glossMayAskModel({ own: true }, "epub")).toBe(false);
    expect(glossMayAskModel({}, "vibe")).toBe(false);
  });
});
