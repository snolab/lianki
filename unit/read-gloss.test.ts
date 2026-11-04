/**
 * A book word's meaning in the in-place review (lib/read/gloss.ts,
 * lib/read/gloss-server.ts): the decks over the book's lemmas, the shared
 * generated glosses, and the backfill of cards made without a meaning.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { parseLemmas } from "@/lib/read/lemma";
import { glossMessages, headOf, lookupGloss, parseGlosses } from "@/lib/read/gloss";
import { chargeAi, fillGlosses, type Complete } from "@/lib/read/gloss-server";
import { scopeSession, type BookCtx, type RangeWord } from "@/lib/read/book-word-list";

const lem = parseLemmas(
  "#lianki-lemmas v1 fr\nreprésenter\t2ait\navaler\t2ait\nfauve\t0s\nboa\t0s\n",
);

describe("rules", () => {
  test("an inflected form finds its headword's meaning", () => {
    const deck = new Map([["représenter", { term: "représenter", back: "to represent" }]]);
    expect(lookupGloss("représentait", "fr", lem, deck)?.back).toBe("to represent");
    // Without the lemmas (what the device had), nothing.
    expect(lookupGloss("représentait", "fr", null, deck)).toBeNull();
  });

  test("a generated meaning is keyed by the headword", () => {
    expect(headOf("avalait", lem)).toBe("avaler");
    expect(headOf("fauve", lem)).toBe("fauve");
    expect(headOf("zzz", null)).toBe("zzz");
  });

  test("the model's answer: only asked words, trimmed; junk is nothing", () => {
    const got = parseGlosses('Sure: {"fauve": " wild  animal; tawny ", "x": "no", "boa": 3}', [
      "fauve",
      "boa",
    ]);
    expect([...got]).toEqual([["fauve", "wild animal; tawny"]]);
    expect(parseGlosses("no json", ["fauve"]).size).toBe(0);
  });
});

describe("filling and backfilling (D1)", () => {
  const EMAIL = "me@example.com";
  let d1: TestD1Database;
  const book: BookCtx = { hash: "h1", title: "Le Petit Prince", lang: "fr", lem };

  beforeEach(() => {
    d1 = createTestD1(testSchema());
    d1.raw()
      .prepare(
        "INSERT INTO word_gloss (lang, term, back, model, created_at) VALUES ('fr', 'fauve', 'wild animal', 'm', 'now')",
      )
      .run();
  });

  test("the decks over the lemmas, then the generated glosses; no model without `ai`", async () => {
    const words: RangeWord[] = [
      { w: "représentait", ex: "Ça représentait un serpent boa." },
      { w: "fauve", ex: "…qui avalait un fauve." },
      { w: "boa", ex: null },
      { w: "livre", back: "book" },
    ];
    const out = await fillGlosses(d1, book, words, null);
    expect(out.map((x) => [x.w, x.term ?? null, x.back ?? null])).toEqual([
      ["représentait", "représenter", "to represent"],
      ["fauve", "fauve", "wild animal"],
      ["boa", null, null],
      ["livre", null, "book"],
    ]);
  });

  test("the model glosses what nothing else has, once: cached, its real cost counted", async () => {
    const asked: string[] = [];
    const complete: Complete = async (body) => {
      const msgs = body.messages as { content: string }[];
      asked.push(msgs[1].content);
      return {
        choices: [{ message: { content: '```json\n{"boa": "boa (snake); feather boa"}\n```' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      };
    };
    const ai = { userId: "u1", complete };
    const out = await fillGlosses(d1, book, [{ w: "boa", ex: "un serpent boa" }], ai);
    expect(out[0]).toMatchObject({ term: "boa", back: "boa (snake); feather boa" });
    expect(JSON.parse(asked[0])).toEqual([{ word: "boa", example: "un serpent boa" }]);
    // Again: from word_gloss, the model not asked.
    await fillGlosses(d1, book, [{ w: "boa", ex: null }], ai);
    expect(asked).toHaveLength(1);
    const msgs = glossMessages("fr", [{ term: "boa", ex: null }]);
    expect(msgs[0].content).toContain('"fr"');
  });

  test("by default the model is Workers AI's OpenAI-compatible endpoint", async () => {
    const env = { ...process.env };
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    process.env.CLOUDFLARE_AI_TOKEN = "tok";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Response.json({
        id: "x",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: '{"boa": "boa"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as typeof fetch;
    try {
      const out = await fillGlosses(d1, book, [{ w: "boa" }], { userId: "u3" });
      expect(out[0].back).toBe("boa");
      expect(urls[0]).toContain("/accounts/acct/ai/v1/chat/completions");
    } finally {
      globalThis.fetch = realFetch;
      process.env = env;
    }
  });

  test("a failing model leaves the word as it was", async () => {
    const complete: Complete = async () => {
      throw new Error("down");
    };
    const out = await fillGlosses(d1, book, [{ w: "boa" }], { userId: "u2", complete });
    expect(out[0].back ?? null).toBeNull();
    expect(await chargeAi("u2", { usd: 0.0001, words: 1 })).toEqual({ ok: true });
  });

  test("a card made without a meaning gets one; a meaning already there is kept", async () => {
    const repo = new WordsD1Repo(d1, EMAIL);
    const list = await repo.createList({ name: "Le Petit Prince", lang: "fr", source: "book:h1" });
    await repo.review(list, [{ term: "fauve", rating: 3 }], "2026-11-03", new Date("2026-11-03"));
    await repo.review(
      list,
      [{ term: "boa", rating: 3, back: "mine" }],
      "2026-11-03",
      new Date("2026-11-03"),
    );
    const gloss = (ws: RangeWord[]) => fillGlosses(d1, book, ws, null);
    const s = await scopeSession(d1, EMAIL, book, [{ w: "fauve" }, { w: "boa" }], gloss);
    expect(s.items.map((i) => [i.term, i.back])).toEqual([
      ["fauve", "wild animal"],
      ["boa", "mine"],
    ]);
    const rows = d1
      .raw()
      .prepare("SELECT term, back FROM word_cards WHERE email = ? ORDER BY term")
      .all(EMAIL);
    expect(rows).toEqual([
      { term: "boa", back: "mine" },
      { term: "fauve", back: "wild animal" },
    ]);
  });
});
