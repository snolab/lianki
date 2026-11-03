import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { importEpub } from "@/lib/epub/unzip";
import { bookMetaOf, checkBook, parseBookMeta } from "@/lib/read/book";
import { summarize, userDeckTerms, userWordCards } from "@/lib/read/progress";
import {
  bookPassed,
  bookProgress,
  cardIndex,
  countWords,
  coveragePercent,
  foldsOf,
  hitOf,
  inKeys,
  langMatches,
  normWord,
  parseWordStats,
  wordLang,
  wordsOf,
  type CardRow,
} from "@/lib/read/words";

// A book's words on /read (lib/read/words.ts): counting, names, matching to
// the reader's word cards, coverage and the 95% pass.

describe("segmentation", () => {
  it("fr: elisions stripped, curly apostrophes, case folded", () => {
    expect(wordsOf("L’homme d’affaires qu’il aime, aujourd’hui. J'ai 3 chats.", "fr")).toEqual([
      "homme",
      "affaires",
      "il",
      "aime",
      "aujourd'hui",
      "ai",
      "chats",
    ]);
  });
  it("en: possessive 's stripped, numbers and single letters left out", () => {
    expect(wordsOf("Della's hair — don't! $1.87, Jim’s watch. I saw a cat.", "en")).toEqual([
      "della",
      "hair",
      "don't",
      "jim",
      "watch",
      "saw",
      "cat",
    ]);
  });
  it("ja: dictionary segmentation, single kanji kept", () => {
    const w = wordsOf("彼は本を読んでいる。", "ja");
    expect(w).toContain("彼");
    expect(w).toContain("本");
    expect(w.every((x) => !/[。、]/.test(x))).toBe(true);
  });
  it("zh: words, full-width folded by NFKC", () => {
    expect(wordsOf("我们今天去北京大学学习中文。", "zh")).toEqual([
      "我们",
      "今天",
      "去",
      "北京",
      "大学",
      "学习",
      "中文",
    ]);
    expect(normWord("ＡＢＣ", "en")).toBe("abc");
  });
  it("guesses the language of pasted text without a tag", () => {
    expect(wordLang("fr-FR")).toBe("fr");
    expect(
      wordLang(undefined, ["Le petit prince et la rose ne sont pas du même avis, je pense."]),
    ).toBe("fr");
    expect(wordLang(undefined, ["The cat was on the mat and she saw it with you."])).toBe("en");
    expect(wordLang(undefined, ["今日はいい天気ですね"])).toBe("ja");
    expect(wordLang(undefined, ["今天天气很好"])).toBe("zh");
  });
});

describe("counting and names", () => {
  it("counts running and distinct words, most frequent first", () => {
    const s = countWords(["The cat and the dog.", "The end."], "en");
    expect(s.tokens).toBe(7);
    expect(s.distinct).toBe(5);
    expect(s.words[0]).toEqual(["the", 3]);
  });
  it("names: capitalised mid-sentence and never lower case", () => {
    const s = countWords(
      [
        "Then Della cried. She looked at Jim and smiled.",
        "Della was happy. It was Christmas, and the king came.",
        "The Lost Kingdom Of Kings", // a title-case heading: no evidence
        "HE SAID NOTHING TO ANYONE.", // all caps: no evidence
      ],
      "en",
    );
    expect(s.names).toContain("della");
    expect(s.names).toContain("jim");
    expect(s.names).toContain("christmas");
    expect(s.names).not.toContain("then"); // sentence-initial only
    expect(s.names).not.toContain("kingdom");
    expect(s.names).not.toContain("said");
  });
  it("no names in German (every noun capitalised) or caseless scripts", () => {
    expect(countWords(["Ich sehe den Hund im Garten."], "de").names).toEqual([]);
    expect(countWords(["我们去北京。"], "zh").names).toEqual([]);
  });
  it("stats survive the book meta round trip; an older version is recounted", () => {
    const checked = checkBook({ title: "T", lang: "en", lines: ["One cat sat.", "Two cats sat."] });
    if (!checked.ok) throw new Error(checked.error);
    const meta = bookMetaOf(checked.book);
    const back = parseBookMeta(JSON.stringify(meta));
    expect(back?.words?.tokens).toBe(6);
    expect(back?.words?.words).toEqual(meta.words!.words);
    expect(parseWordStats({ ...meta.words, v: 0 })).toBeNull();
  });
});

const card = (term: string, interval: number, extra: Partial<CardRow> = {}): CardRow => ({
  term,
  lang: "en",
  stability: interval,
  interval,
  cap: 365,
  ...extra,
});

describe("matching and coverage", () => {
  it("folds only into forms that are cards", () => {
    expect(foldsOf("cats", "en")).toContain("cat");
    expect(foldsOf("walked", "en")).toContain("walk");
    expect(foldsOf("is", "en")).toEqual(["is"]); // "i" is too short to fold to
    const idx = cardIndex([card("cat", 400)]);
    expect(hitOf("cats", "en", idx)?.mastered).toBe(true);
    expect(hitOf("dogs", "en", idx)).toBeNull();
  });
  it("folds per language; list keys; list languages", () => {
    expect(foldsOf("walking", "en")).toEqual(["walking", "walk", "walke"]);
    expect(foldsOf("hurried", "en")).toContain("hurry");
    expect(foldsOf("stories", "en")).toContain("story");
    expect(foldsOf("belles", "fr")).toEqual(["belles", "bell", "belle"]);
    expect(foldsOf("chevaux", "fr")).toContain("chevau");
    expect(foldsOf("我们", "zh")).toEqual(["我们"]);
    expect(inKeys("chats", "fr", new Set(["chat"]))).toBe(true);
    expect(inKeys("chiens", "fr", new Set(["chat"]))).toBe(false);
    expect(langMatches("en-US", "en")).toBe(true);
    expect(langMatches("fr", "en")).toBe(false);
    expect(langMatches("fr", "und")).toBe(true);
  });
  it("mastered as a /words deck counts it: interval a year, or the list's cap", () => {
    const idx = cardIndex([card("cat", 400), card("dog", 30), card("cow", 60, { cap: 60 })]);
    expect(hitOf("cat", "en", idx)?.mastered).toBe(true);
    expect(hitOf("dog", "en", idx)?.mastered).toBe(false);
    expect(hitOf("cow", "en", idx)?.mastered).toBe(true);
  });
  it("the best card of any list wins; Japanese readings match", () => {
    const idx = cardIndex([card("cat", 10), card("Cat", 500)]);
    expect(hitOf("cat", "en", idx)?.mastered).toBe(true);
    const ja = cardIndex([
      { term: "猫", reading: "ねこ", lang: "ja", interval: 400, stability: 400 },
    ]);
    expect(hitOf("ねこ", "ja", ja)?.mastered).toBe(true);
  });
  it("coverage: mastered running words plus names over running words; passes at 95%", () => {
    const lines = ["Then Della said the cat saw the dog.", "The cat ran."];
    const s = countWords(lines, "en");
    // then della said the cat saw the dog the cat ran = 11 running words
    expect(s.tokens).toBe(11);
    const p = bookProgress(s, cardIndex([card("the", 400), card("cat", 400), card("dog", 5)]));
    expect(p.mastered).toBe(2);
    expect(p.seen).toBe(3);
    expect(p.masteredTokens).toBe(5); // the ×3, cat ×2
    expect(p.nameTokens).toBe(1); // della
    expect(coveragePercent(p, s)).toBe(54); // 6 / 11
    expect(bookPassed(p, s)).toBe(false);
    const all = bookProgress(
      s,
      cardIndex(["then", "said", "the", "cat", "saw", "dog", "ran"].map((w) => card(w, 400))),
    );
    expect(coveragePercent(all, s)).toBe(100);
    expect(bookPassed(all, s)).toBe(true);
  });
});

describe("the reader's cards: one query, scoped to them", () => {
  it("reads only their cards in the book's language, across lists", async () => {
    const db = createTestD1(testSchema());
    const now = new Date().toISOString();
    const list = (email: string, id: string, lang: string, params = "{}") =>
      db
        .prepare(
          "INSERT INTO word_lists (email, id, name, lang, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(email, id, id, lang, params, now, now)
        .run();
    const put = (email: string, listId: string, term: string, days: number) =>
      db
        .prepare(
          "INSERT INTO word_cards (email, list_id, term, card, card_due, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          email,
          listId,
          term,
          JSON.stringify({ stability: days, scheduled_days: days, state: 2 }),
          now,
          now,
        )
        .run();
    await list("me@x", "en1", "en");
    await list("me@x", "en2", "en-US", JSON.stringify({ maxIntervalDays: 90 }));
    await list("me@x", "fr1", "fr");
    await list("you@x", "en9", "en");
    await put("me@x", "en1", "cat", 400);
    await put("me@x", "en2", "dog", 90);
    await put("me@x", "fr1", "chat", 400);
    await put("you@x", "en9", "the", 400);

    const rows = await userWordCards(db, "me@x", ["en"]);
    expect(rows.map((r) => r.term).sort()).toEqual(["cat", "dog"]);
    expect(rows.find((r) => r.term === "dog")?.cap).toBe(90);

    const s = countWords(["The cat and the dog."], "en");
    const [sum] = await summarize(db, "me@x", [s]);
    expect(sum.progress?.mastered).toBe(2); // dog is at its list's 90-day cap
    expect(sum.progress?.masteredTokens).toBe(2);
    expect(sum.coverage).toBe(40);
    expect(sum.passAt).toBe(95);

    await db
      .prepare(
        "INSERT INTO word_list_entries (email, list_id, key, position, term, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("me@x", "en1", "k1", 0, "mouse", now)
      .run();
    expect((await userDeckTerms(db, "me@x", "en")).map((e) => e.term)).toEqual(["mouse"]);
    expect(await userDeckTerms(db, "you@x", "en")).toEqual([]);
  });
});

describe("the Project Gutenberg fixture", () => {
  it("counts The Gift of the Magi", async () => {
    const buf = readFileSync("unit/fixtures/epub/pg7256-gift-of-the-magi.epub");
    const book = await importEpub(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    const s = countWords(book.lines, book.lang);
    expect(s.lang).toBe("en");
    expect(s.tokens).toBeGreaterThan(4000);
    expect(s.distinct).toBeGreaterThan(1000);
    expect(s.names).toContain("della");
    expect(s.names).toContain("jim");
    expect(s.names).not.toContain("the");
  });
});
