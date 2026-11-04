/**
 * Reviewing a paragraph's words from the reader (lib/read/word-review.ts,
 * lib/read/book-word-list.ts): the order, which card a word is graded on,
 * and the rule that a word with a card anywhere never gets a second one.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createEmptyCard } from "ts-fsrs";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { parseLemmas } from "@/lib/read/lemma";
import {
  addGradedEntries,
  makeCards,
  scopeSession,
  unmakeCards,
  type BookCtx,
} from "@/lib/read/book-word-list";
import {
  cardOrder,
  deckIndex,
  matchCard,
  missingWords,
  newCardTerm,
  orderWords,
  paraWords,
  spanWords,
  type DeckCard,
} from "@/lib/read/word-review";
import type { Fam, Sentence } from "@/lib/read/reader-model";

const card = (o: Partial<DeckCard>): DeckCard => ({
  listId: "a",
  listName: "A",
  term: "x",
  reading: null,
  lastReview: null,
  due: "2026-11-04T00:00:00Z",
  ...o,
});

const sentence = (words: string[]): Sentence => ({
  text: words.join(" "),
  segs: words.flatMap((w, i) => [
    ...(i ? [{ text: " ", t: -1, w: null }] : []),
    { text: w, t: i, w: w.toLowerCase() },
  ]),
});

describe("orderWords", () => {
  test("unrecognised, new, learning weakest first, then known; reading order inside", () => {
    const fam = new Map<string, Fam>([
      ["the", "k"],
      ["cat", "l2"],
      ["sat", "n"],
      ["quietly", "u"],
      ["on", "k"],
      ["mat", "l1"],
    ]);
    const words = paraWords([sentence(["The", "cat", "sat", "quietly", "on", "the", "mat"])], fam);
    expect(words.map((w) => w.w)).toEqual(["the", "cat", "sat", "quietly", "on", "mat"]);
    const { first, rest } = orderWords(words);
    expect(first.map((w) => w.w)).toEqual(["quietly", "sat", "mat", "cat"]);
    expect(rest.map((w) => w.w)).toEqual(["the", "on"]);
  });

  test("a word the map has not placed counts as new", () => {
    const words = paraWords([sentence(["alpha", "beta"])], new Map([["alpha", "k"]]));
    expect(orderWords(words).first.map((w) => w.w)).toEqual(["beta"]);
  });

  test("missing: only new and unrecognised words (no card anywhere)", () => {
    const fam = new Map<string, Fam>([
      ["a", "n"],
      ["b", "u"],
      ["c", "l1"],
      ["d", "k"],
    ]);
    const words = paraWords([sentence(["a", "b", "c", "d"])], fam);
    expect(missingWords(words).map((w) => w.w)).toEqual(["a", "b"]);
  });
});

describe("matchCard", () => {
  test("matches through the reader's folds and lemmas (regarda → regarder)", () => {
    const lem = parseLemmas("#lianki-lemmas v1 fr\nregarder\t2a 1\n");
    const idx = deckIndex([card({ term: "regarder" })], "fr");
    expect(matchCard("regarda", "fr", idx, lem)?.term).toBe("regarder");
    expect(matchCard("regarda", "fr", idx, null)).toBeNull();
  });

  test("a card term with a gloss answers to its head", () => {
    const idx = deckIndex([card({ term: "être (verb)" })], "fr");
    expect(matchCard("être", "fr", idx)?.term).toBe("être (verb)");
  });

  test("several lists: the card reviewed most recently, then due soonest, then list id", () => {
    const old = card({ listId: "b", lastReview: "2026-10-01T00:00:00Z", term: "chat" });
    const recent = card({ listId: "c", lastReview: "2026-11-01T00:00:00Z", term: "chat" });
    const never = card({ listId: "a", lastReview: null, term: "chat" });
    for (const order of [
      [old, recent, never],
      [never, recent, old],
      [recent, never, old],
    ])
      expect(matchCard("chat", "fr", deckIndex(order, "fr"))?.listId).toBe("c");
    const soon = card({ listId: "z", due: "2026-11-02T00:00:00Z", term: "chien" });
    const late = card({ listId: "y", due: "2026-12-01T00:00:00Z", term: "chien" });
    expect(matchCard("chien", "fr", deckIndex([late, soon], "fr"))?.listId).toBe("z");
    const tieA = card({ listId: "m", term: "loup" });
    const tieB = card({ listId: "n", term: "loup" });
    expect(cardOrder(tieA, tieB)).toBeLessThan(0);
    expect(matchCard("loup", "fr", deckIndex([tieB, tieA], "fr"))?.listId).toBe("m");
  });

  test("a new card's term: the suggested headword only when it is one of the word's folds", () => {
    const lem = parseLemmas("#lianki-lemmas v1 fr\nregarder\t2a 1\n");
    expect(newCardTerm("regarda", "fr", "regarder", lem)).toBe("regarder");
    expect(newCardTerm("regarda", "fr", "manger", lem)).toBe("regarda");
    expect(newCardTerm("regarda", "fr", null, lem)).toBe("regarda");
  });
});

describe("the book's list (D1)", () => {
  const EMAIL = "me@example.com";
  let d1: TestD1Database;
  let repo: WordsD1Repo;
  const book: BookCtx = { hash: "h1", title: "Le Livre", lang: "fr", names: new Set(["marie"]) };
  const NOW = new Date("2026-11-03T12:00:00Z");

  beforeEach(async () => {
    d1 = createTestD1(testSchema());
    repo = new WordsD1Repo(d1, EMAIL);
    // His deck already has "chat", reviewed twice.
    const deck = await repo.createList({ name: "French 1000", lang: "fr", source: "fr-1000" });
    await repo.review(deck, [{ term: "chat", rating: 3 }], "2026-10-01", new Date("2026-10-01"));
    await repo.review(deck, [{ term: "chat", rating: 3 }], "2026-10-20", new Date("2026-10-20"));
  });

  const bookLists = async () => (await repo.lists()).filter((l) => l.source === "book:h1");

  test("an existing card is reviewed as it is: no book list when every word has a card", async () => {
    const s = await scopeSession(d1, EMAIL, book, [{ w: "chat", ex: "Le chat dort." }]);
    expect(s.missing).toEqual([]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0].listId).not.toBe(undefined);
    expect(JSON.parse(s.items[0].card!).reps).toBe(2);
    expect(s.lists.map((l) => l.name)).toEqual(["French 1000"]);
    expect(await bookLists()).toHaveLength(0);
  });

  test("a card not due yet stays out of the review until its due", async () => {
    // "chat" graded Easy just now: due days from now.
    const [deck] = (await repo.lists()).filter((l) => l.source === "fr-1000");
    const at = new Date("2026-10-21T12:00:00Z");
    await repo.review(deck.id, [{ term: "chat", rating: 4 }], "2026-10-21", at);
    const words = [{ w: "chat", ex: "Le chat dort." }, { w: "chien" }];
    const soon = await scopeSession(d1, EMAIL, book, words, undefined, at);
    expect(soon.items.map((i) => i.term)).toEqual(["chien"]);
    expect(soon.lists.every((l) => l.source !== "fr-1000")).toBe(true);
    const later = await scopeSession(d1, EMAIL, book, words, undefined, new Date("2027-06-01"));
    expect(later.items.map((i) => i.term)).toEqual(["chat", "chien"]);
  });

  test("words without a card come from the book's list; names are left out", async () => {
    const s = await scopeSession(d1, EMAIL, book, [
      { w: "chien", ex: "Le chien court.", back: "dog" },
      { w: "chat" },
      { w: "marie" },
    ]);
    expect(s.missing).toEqual(["chien"]);
    const [list] = await bookLists();
    expect(list.name).toBe("Le Livre");
    expect(s.items.map((i) => [i.term, i.listId === list.id, i.card === null])).toEqual([
      ["chien", true, true],
      ["chat", false, false],
    ]);
  });

  test("制卡 makes cards only for words with none anywhere; again makes nothing", async () => {
    const words = [
      { w: "chien", ex: "Le chien court.", back: "dog" },
      { w: "chat", ex: "Le chat dort." },
    ];
    const r = await makeCards(d1, EMAIL, book, words, NOW);
    expect(r.terms).toEqual(["chien"]);
    const again = await makeCards(d1, EMAIL, book, words, NOW);
    expect(again.terms).toEqual([]);
    const rows = d1
      .raw()
      .prepare("SELECT list_id, term, reps FROM word_cards WHERE email = ? ORDER BY term")
      .all(EMAIL) as { list_id: string; term: string; reps: number }[];
    // One "chat" (his deck's, its two reviews kept) and one new "chien".
    expect(rows.map((x) => [x.term, x.reps])).toEqual([
      ["chat", 2],
      ["chien", 0],
    ]);
    expect((await bookLists())[0].size).toBe(1);
    // The new card is now the word's card: the review shows it, not a new word.
    const s = await scopeSession(d1, EMAIL, book, words);
    expect(s.missing).toEqual([]);
    expect(JSON.parse(s.items[0].card!).state).toBe(createEmptyCard(NOW).state);
  });

  test("undo removes only the cards still unreviewed", async () => {
    await makeCards(d1, EMAIL, book, [{ w: "chien" }, { w: "loup" }], NOW);
    const [list] = await bookLists();
    await repo.review(list.id, [{ term: "loup", rating: 3 }], "2026-11-03", NOW);
    expect(await unmakeCards(d1, EMAIL, "h1", ["chien", "loup"])).toBe(1);
    const terms = (
      d1.raw().prepare("SELECT term FROM word_cards WHERE list_id = ?").all(list.id) as {
        term: string;
      }[]
    ).map((x) => x.term);
    expect(terms).toEqual(["loup"]);
    // The graded card keeps its entry.
    expect((await bookLists())[0].size).toBe(1);
  });

  test("a new word graded in the review joins the book list's entries once", async () => {
    const s = await scopeSession(d1, EMAIL, book, [{ w: "chien", ex: "Le chien court." }]);
    await repo.review(s.items[0].listId, [{ term: "chien", rating: 1 }], "2026-11-03", NOW);
    expect(await addGradedEntries(d1, EMAIL, book, [{ w: "chien", ex: "Le chien court." }])).toBe(
      1,
    );
    await addGradedEntries(d1, EMAIL, book, [{ w: "chien" }]);
    // Never an entry for a word his deck has.
    expect(await addGradedEntries(d1, EMAIL, book, [{ w: "chat" }])).toBe(0);
    // Nor for one with no card yet (its grade not synced): no uncarded entries.
    expect(await addGradedEntries(d1, EMAIL, book, [{ w: "loup" }])).toBe(0);
    const [list] = await bookLists();
    expect(list.size).toBe(1);
  });
});

describe("spanWords (a hand-made selection)", () => {
  test("only the range's tokens, distinct across paragraphs, each with its own sentence", () => {
    const p1 = [sentence(["The", "cat", "sat"]), sentence(["A", "dog", "ran"])];
    const p2 = [sentence(["The", "dog", "slept"])];
    const fam = new Map<string, Fam>([
      ["dog", "n"],
      ["ran", "k"],
    ]);
    // From "dog" (token 1 of p1's 2nd sentence) to "dog" of p2 (token 1).
    const { sentences, words } = spanWords(
      [
        {
          ss: [
            { ...p1[0] },
            { ...p1[1], segs: p1[1].segs.map((g) => ({ ...g, t: g.t < 0 ? -1 : g.t + 3 })) },
          ],
          from: 4,
          to: null,
        },
        { ss: p2, from: null, to: 1 },
      ],
      fam,
    );
    expect(words.map((w) => w.w)).toEqual(["dog", "ran", "the"]);
    expect(words.map((w) => w.fam)).toEqual(["n", "k", undefined]);
    // The example of each word is the sentence it first occurs in.
    expect(words.map((w) => sentences[w.s].text)).toEqual([
      "A dog ran",
      "A dog ran",
      "The dog slept",
    ]);
    expect(missingWords(words).map((w) => w.w)).toEqual(["dog"]);
  });
});
