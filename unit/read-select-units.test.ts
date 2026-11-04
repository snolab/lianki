/**
 * The selection card's units (owner, 2026-11-05 00:35–00:46 JST): the deck
 * card a selection is (word → phrase, longest first, his cards first), the
 * whole sentences or paragraphs it translates as, the device's cache key,
 * and a phrase card made in the book's own deck like a word's.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { parseLemmas } from "@/lib/read/lemma";
import { makeCards, type BookCtx } from "@/lib/read/book-word-list";
import { cutPara, type Sentence } from "@/lib/read/reader-model";
import type { Unit } from "@/lib/read/reader-select";
import {
  bookPhrase,
  matchMeaning,
  meaningIndex,
  phraseKey,
  phraseTokens,
  wordMeaning,
  type Meaning,
} from "@/lib/read/select-meaning";
import { bookMeanings, readBookMeanings } from "@/lib/read/select-meaning-server";
import { autoPieces, sentenceSpan, transKey, translationPlan } from "@/lib/read/select-translate";
import { MAX_TRANSLATE_CHARS } from "@/lib/read/translate";
import { formLabel, formLabels, type FormTagKey } from "@/lib/read/form-tags";

const toksOf = (text: string, lang: string) => {
  const out: string[] = [];
  for (const s of cutPara(text, lang).sentences)
    for (const g of s.segs) if (g.t >= 0) out[g.t] = g.text;
  return out;
};
const m = (term: string, back = `meaning of ${term}`): Meaning => ({ term, back });

describe("meanings: word → phrase, the longest card", () => {
  const fr = "Il y a longtemps, il y avait un roi.";
  const toks = toksOf(fr, "fr"); // Il y a longtemps il y avait un roi
  const mine = meaningIndex([m("il y a"), m("roi"), m("longtemps")], "fr");
  const pub = meaningIndex([m("il y a longtemps"), m("y"), m("un")], "fr");

  test("a word inside a phrase card is that phrase; the longest wins over his shorter one", () => {
    const y = toks.indexOf("y");
    expect(matchMeaning(toks, y, y, [mine], "fr")).toMatchObject({
      m: { term: "il y a" },
      t0: 0,
      t1: 2,
      inside: true,
    });
    expect(matchMeaning(toks, y, y, [mine, pub], "fr")?.m.term).toBe("il y a longtemps");
  });

  test("at equal length his card comes first", () => {
    const other = meaningIndex([m("il y a", "public")], "fr");
    expect(matchMeaning(toks, 0, 2, [mine, other], "fr")?.m.back).toBe("meaning of il y a");
  });

  test("a single word is matched only when it is the whole selection", () => {
    const roi = toks.indexOf("roi");
    expect(matchMeaning(toks, roi, roi, [mine], "fr")?.m.term).toBe("roi");
    // "un roi": no phrase card, and a word inside a longer selection is no answer.
    expect(matchMeaning(toks, roi - 1, roi, [mine], "fr")).toBeNull();
  });

  test("a ragged selection that covers a phrase card shows it, not as the selection itself", () => {
    // "a longtemps il": covers no card; "Il y a longtemps il" covers "il y a longtemps".
    expect(matchMeaning(toks, 0, 4, [mine, pub], "fr")).toMatchObject({
      m: { term: "il y a longtemps" },
      inside: false,
    });
  });

  test("an inflected phrase matches through the language's folds", () => {
    const en = toksOf("They gave up at last.", "en");
    const idx = meaningIndex([m("give up")], "en");
    // "gave" is no fold of "give" (an irregular past), "gives up" is.
    expect(matchMeaning(en, 1, 2, [idx], "en")).toBeNull();
    const en2 = toksOf("She gives up.", "en");
    expect(matchMeaning(en2, 1, 2, [idx], "en")?.m.term).toBe("give up");
  });

  test("a multi-character expression in a script without spaces", () => {
    const text = "他一石二鸟地解决了问题。";
    const toks = toksOf(text, "zh");
    const idx = meaningIndex([m("一石二鸟")], "zh");
    const n = phraseTokens("一石二鸟", "zh").length;
    const start = toks.indexOf(phraseTokens("一石二鸟", "zh")[0]);
    const hit = matchMeaning(toks, start, start, [idx], "zh");
    expect(hit?.m.term).toBe("一石二鸟");
    expect(hit!.t1 - hit!.t0 + 1).toBe(n);
  });

  test("the lemma's card: a word's own form, then its folds", () => {
    const idx = meaningIndex([m("chat")], "fr");
    expect(wordMeaning("chats", [idx], "fr")?.term).toBe("chat");
    expect(wordMeaning("chien", [idx], "fr")).toBeNull();
  });

  test("a phrase's key and whether a card can be made under it", () => {
    expect(phraseKey("  Il y a, ")).toBe("il y a");
    expect(phraseKey("Give  Up!")).toBe("give up");
    const book = new Set(["il", "longtemps"]);
    const has = (w: string) => book.has(w);
    expect(bookPhrase("il y a", "fr", has)).toBe(true); // "y", "a" are lone letters, not counted
    expect(bookPhrase("il y a longtemps", "fr", has)).toBe(true);
    expect(bookPhrase("il y avait", "fr", has)).toBe(false); // "avait" is not in the book
    expect(bookPhrase("Il y a", "fr", has)).toBe(false); // not in its phrase form
    expect(bookPhrase("longtemps", "fr", has)).toBe(false); // one word: a word's path
  });
});

describe("the book's meanings (server, pure)", () => {
  const lem = parseLemmas("#lianki-lemmas v1 fr\nregarder\t2a 1\n");
  test("single cards matched over lemmas, phrases only when the book has their words, heads", () => {
    const all = [m("regarder"), m("il y a"), m("tout à fait"), m("absent"), m("vide", "")];
    const r = bookMeanings(all, ["regarda", "il", "roi", "vide"], "fr", lem);
    expect(r.cards.map((c) => c.term)).toEqual(["il y a", "regarder"]);
    expect(r.forms).toEqual([["regarda", 1]]);
    expect(r.heads).toEqual([["regarda", "regarder", []]]);
  });

  test("with lemma file v2, each head carries its form's tag sets: a label, no model", () => {
    const v2 = parseLemmas(
      [
        "#lianki-lemmas v2 fr",
        "#tags past historic third-person singular first-person present",
        "#sets 0.1.2.3 5.4.3,5.2.3",
        "regarder\t2a:0 1:1",
        "",
      ].join("\n"),
    );
    const r = bookMeanings([], ["regarda", "regarde"], "fr", v2);
    expect(r.heads).toEqual([
      ["regarda", "regarder", [["past", "historic", "third-person", "singular"]]],
      [
        "regarde",
        "regarder",
        [
          ["present", "first-person", "singular"],
          ["present", "third-person", "singular"],
        ],
      ],
    ]);
    const zh = new Proxy({} as Record<FormTagKey, string>, {
      get: (_, k) => `<${String(k)}>`,
    });
    expect(formLabels(r.heads[0][2], zh).join(" / ")).toBe(
      formLabel(["past", "historic", "third-person", "singular"], zh),
    );
    expect(formLabels(r.heads[0][2], zh)[0]).not.toBe("");
  });
});

describe("translation: whole sentences, whole paragraphs", () => {
  const p0 = "Le soleil brille. Les oiseaux chantent. Il fait beau.";
  const p1 = "Une phrase seule.";
  const p2 = "Deux phrases ici. Et une autre.";
  const p3 = "Encore une. Et la fin.";
  const paras = [p0, p1, p2, p3].map((t) => cutPara(t, "fr").sentences);
  const sentences = (l: number): readonly Sentence[] | null => paras[l] ?? null;
  const tokIn = (l: number, word: string) => {
    for (const s of paras[l]) for (const g of s.segs) if (g.text === word) return g.t;
    throw new Error(word);
  };
  const shape = (u: Unit) =>
    translationPlan(u, sentences)?.map((b) => b.map((p) => `${p.level}:${p.line}.${p.s}`));

  test("a sentence is itself; a paragraph is one piece", () => {
    expect(shape({ kind: "sentence", line: 0, s: 1 })).toEqual([["sentence:0.1"]]);
    expect(shape({ kind: "para", line: 0 })).toEqual([["para:0.-1"]]);
    expect(translationPlan({ kind: "para", line: 0 }, sentences)![0][0].text).toBe(p0);
    expect(translationPlan({ kind: "word", line: 0, t: 0 }, sentences)).toBeNull();
  });

  test("a ragged range in one paragraph grows to whole sentences", () => {
    // From "brille" to "oiseaux": sentences 0 and 1.
    const u: Unit = {
      kind: "range",
      l0: 0,
      t0: tokIn(0, "brille"),
      l1: 0,
      t1: tokIn(0, "oiseaux"),
    };
    expect(shape(u)).toEqual([["sentence:0.0", "sentence:0.1"]]);
    expect(translationPlan(u, sentences)![0][1].text).toBe("Les oiseaux chantent.");
    expect(sentenceSpan(paras[0], tokIn(0, "brille"), tokIn(0, "oiseaux"))).toEqual([0, 1]);
  });

  test("grown to every sentence, a range is the paragraph", () => {
    const u: Unit = { kind: "range", l0: 0, t0: tokIn(0, "soleil"), l1: 0, t1: tokIn(0, "beau") };
    expect(shape(u)).toEqual([["para:0.-1"]]);
  });

  test("across paragraphs, covering one whole: every paragraph whole, one call each, in order", () => {
    const u: Unit = { kind: "range", l0: 0, t0: tokIn(0, "beau"), l1: 2, t1: tokIn(2, "Deux") };
    expect(shape(u)).toEqual([["para:0.-1"], ["para:1.-1"], ["para:2.-1"]]);
  });

  test("across paragraphs, covering none whole: their sentences", () => {
    // The tail of one paragraph and the head of the next: their sentences.
    const u: Unit = { kind: "range", l0: 2, t0: tokIn(2, "autre"), l1: 3, t1: tokIn(3, "Encore") };
    expect(shape(u)).toEqual([["sentence:2.1"], ["sentence:3.0"]]);
    const v: Unit = { kind: "range", l0: 0, t0: tokIn(0, "beau"), l1: 0, t1: tokIn(0, "beau") };
    expect(shape(v)).toEqual([["sentence:0.2"]]);
  });

  test("a paragraph longer than one call takes goes by its sentences", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Phrase numéro ${i} est là.`).join(" ");
    expect(long.length).toBeGreaterThan(MAX_TRANSLATE_CHARS);
    const ss = cutPara(long, "fr").sentences;
    const plan = translationPlan({ kind: "para", line: 0 }, () => ss)!;
    expect(plan[0].every((p) => p.level === "sentence")).toBe(true);
    expect(plan[0]).toHaveLength(ss.length);
  });

  test("what goes by itself stops at the bound; the first piece always goes", () => {
    const plan = translationPlan({ kind: "para", line: 0 }, sentences)!;
    expect(autoPieces(plan, 1).size).toBe(1);
    const three = translationPlan(
      { kind: "range", l0: 0, t0: tokIn(0, "beau"), l1: 2, t1: tokIn(2, "Deux") },
      sentences,
    )!;
    expect(autoPieces(three, p0.length + p1.length).size).toBe(2);
    expect(autoPieces(three).size).toBe(3);
  });

  test("the cache key is the target and the normalised text: one entry per unit", () => {
    expect(transKey("zh", " Le  soleil brille. ")).toBe(transKey("zh", "Le soleil brille."));
    expect(transKey("zh", "Le soleil brille.")).not.toBe(transKey("ja", "Le soleil brille."));
    expect(transKey("zh", p0)).not.toBe(transKey("zh", "Le soleil brille."));
  });
});

describe("a phrase card, in the book's own deck (D1)", () => {
  const EMAIL = "me@example.com";
  let d1: TestD1Database;
  let repo: WordsD1Repo;
  const book: BookCtx = { hash: "h9", title: "Le Livre", lang: "fr" };
  const NOW = new Date("2026-11-05T00:00:00Z");
  beforeEach(() => {
    d1 = createTestD1(testSchema());
    repo = new WordsD1Repo(d1, EMAIL);
  });

  test("made like a word's card, under the phrase; the book's deck made once, named after it", async () => {
    const [a, b] = await Promise.all([
      makeCards(d1, EMAIL, book, [{ w: "il y a", ex: "Il y a un roi.", back: "there is" }], NOW),
      makeCards(d1, EMAIL, book, [{ w: "tout à fait", back: "quite" }], NOW),
    ]);
    expect(a.terms).toEqual(["il y a"]);
    expect(b.terms).toEqual(["tout à fait"]);
    const lists = (await repo.lists()).filter((l) => l.source === "book:h9");
    expect(lists.map((l) => [l.name, l.size])).toEqual([["Le Livre", 2]]);
    // Never a second card for the same phrase.
    expect((await makeCards(d1, EMAIL, book, [{ w: "il y a", back: "x" }], NOW)).terms).toEqual([]);
  });

  test("his cards' meanings come back for the book, with their list", async () => {
    await makeCards(
      d1,
      EMAIL,
      book,
      [
        { w: "il y a", back: "there is" },
        { w: "roi", back: "king" },
      ],
      NOW,
    );
    const r = await readBookMeanings(d1, EMAIL, "fr", ["il", "roi"], null);
    const [list] = (await repo.lists()).filter((l) => l.source === "book:h9");
    expect(r.cards.map((c) => [c.term, c.back, c.listId === list.id])).toEqual([
      ["il y a", "there is", true],
      ["roi", "king", true],
    ]);
    expect(r.forms).toEqual([["roi", 1]]);
  });

  test("a CJK multi-character expression is a term like any other", async () => {
    const zh: BookCtx = { hash: "hz", title: "书", lang: "zh" };
    const r = await makeCards(d1, EMAIL, zh, [{ w: "一石二鸟", back: "kill two birds" }], NOW);
    expect(r.terms).toEqual(["一石二鸟"]);
  });
});
