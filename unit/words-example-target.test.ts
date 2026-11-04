import { describe, expect, it } from "bun:test";
import {
  examplePieces,
  looseKey,
  markSpoken,
  pieceRuns,
  targetSpans,
  type Span,
} from "@/lib/words/example-target";
import { centreIn } from "@/lib/words/centre-in";
import { recordHeads, type HeadMap } from "@/lib/words/example-marks";
import { parseLemmas } from "@/lib/read/lemma";
import { foldsOf, headsOfWords, lemmaHeads, wordsOf } from "@/lib/read/words";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const marked = (text: string, spans: Span[]) => spans.map(([a, b]) => text.slice(a, b));
const find = (text: string, forms: (string | null)[], lang: string) =>
  marked(text, targetSpans(text, forms, lang));

describe("targetSpans", () => {
  it("finds the word, case-insensitively, every occurrence", () => {
    expect(find("On disait Dans le livre, dans la forêt", ["dans"], "fr")).toEqual([
      "Dans",
      "dans",
    ]);
  });

  it("matches whole words only where the language has spaces", () => {
    // "dans" is not inside "danse" while a real "dans" exists.
    expect(find("Une danse dans la nuit", ["dans"], "fr")).toEqual(["dans"]);
  });

  it("ignores diacritics both ways", () => {
    expect(find("Il était une fois une foret", ["forêt"], "fr")).toEqual(["foret"]);
    expect(find("Une forêt", ["foret"], "fr")).toEqual(["forêt"]);
  });

  it("takes the elided word whole (l'homme for homme)", () => {
    expect(find("C'est l’homme du livre", ["homme"], "fr")).toEqual(["l’homme"]);
  });

  it("finds a plural through the language's folds", () => {
    expect(find("The cats sat on the mat", ["cat"], "en")).toEqual(["cats"]);
  });

  it("finds a form of several words as one stretch", () => {
    expect(find("C'est tout à fait vrai", ["tout à fait"], "fr")).toEqual(["tout à fait"]);
  });

  it("falls back to a substring where words are not spaced", () => {
    expect(find("我们今天去图书馆看书。", ["图书馆"], "zh")).toEqual(["图书馆"]);
    expect(find("駅まで歩いて行きます", ["歩いて"], "ja")).toEqual(["歩いて"]);
  });

  it("uses the reading when the example spells the word in kana", () => {
    expect(find("ねこがすきです", ["猫", "ねこ"], "ja")).toEqual(["ねこ"]);
  });

  it("finds an inflection the folds miss by its stem, the whole word", () => {
    expect(find("sans la mâchait. Ensuite", ["mâcher"], "fr")).toEqual(["mâchait"]);
  });

  it("finds nothing when the word is not there", () => {
    expect(targetSpans("Le chat dort", ["chien"], "fr")).toEqual([]);
    expect(targetSpans("", ["chat"], "fr")).toEqual([]);
    expect(targetSpans("Le chat", [null, "  "], "fr")).toEqual([]);
  });

  it("works on scripts written right to left", () => {
    expect(find("הספר על השולחן", ["הספר"], "he")).toEqual(["הספר"]);
  });
});

describe("examplePieces", () => {
  it("joins back into the example, with the target's pieces marked", () => {
    const text = "C'est tout à fait vrai";
    const pieces = examplePieces(text, "fr", targetSpans(text, ["tout à fait"], "fr"));
    expect(pieces.map((p) => p.text).join("")).toBe(text);
    const runs = pieceRuns(pieces);
    expect(runs.filter((r) => r.target).map((r) => r.pieces.map((p) => p.text).join(""))).toEqual([
      "tout à fait",
    ]);
  });

  it("cuts a word at a substring match and drops its familiarity there", () => {
    const text = "我们去图书馆";
    const pieces = examplePieces(text, "zh", [[3, 6]]);
    expect(pieces.map((p) => p.text).join("")).toBe(text);
    expect(
      pieces
        .filter((p) => p.target)
        .map((p) => p.text)
        .join(""),
    ).toBe("图书馆");
  });

  it("keeps every piece plain without a target", () => {
    const pieces = examplePieces("Le chat dort", "fr", []);
    expect(pieces.every((p) => !p.target)).toBe(true);
    expect(pieces.find((p) => p.text === "chat")?.word).toBe("chat");
  });
});

describe("looseKey", () => {
  it("folds case, diacritics and the curly apostrophe", () => {
    expect(looseKey("L’Été")).toBe("l'ete");
  });
});

describe("centreIn", () => {
  const rect = (top: number, left: number, h: number, w: number) => ({
    top,
    left,
    bottom: top + h,
    right: left + w,
    height: h,
    width: w,
  });
  const box = (calls: unknown[]) =>
    ({
      getBoundingClientRect: () => rect(0, 0, 100, 200),
      scrollBy: (o: unknown) => calls.push(o),
    }) as unknown as HTMLElement;
  const el = (top: number, left: number) =>
    ({ getClientRects: () => [rect(top, left, 20, 40)] }) as unknown as HTMLElement;

  it("leaves a word already in view alone", () => {
    const calls: unknown[] = [];
    centreIn(box(calls), el(10, 10), false);
    expect(calls).toEqual([]);
  });

  it("scrolls the box so a word below it is in its middle", () => {
    const calls: unknown[] = [];
    centreIn(box(calls), el(190, 10), true);
    expect(calls).toEqual([{ top: 150, left: 0, behavior: "smooth" }]);
  });

  it("scrolls sideways for a word past its end", () => {
    const calls: unknown[] = [];
    centreIn(box(calls), el(10, 300), false);
    expect(calls).toEqual([{ top: 0, left: 220, behavior: "auto" }]);
  });
});

describe("markSpoken", () => {
  it("cuts pieces at the spoken word and marks it, the target kept", () => {
    const text = "Le chat dort";
    const pieces = examplePieces(text, "fr", [[3, 7]]);
    const m = markSpoken(pieces, [8, 12]);
    expect(m.map((p) => p.text).join("")).toBe(text);
    expect(m.filter((p) => p.spoken).map((p) => p.text)).toEqual(["dort"]);
    expect(m.filter((p) => p.target).map((p) => p.text)).toEqual(["chat"]);
  });
  it("a spoken stretch inside one piece splits it", () => {
    const pieces = [{ text: "abcdef", word: "abcdef", target: false }];
    const m = markSpoken(pieces, [2, 4]);
    expect(m.map((p) => [p.text, p.spoken])).toEqual([
      ["ab", false],
      ["cd", true],
      ["ef", false],
    ]);
    expect(m.every((p) => p.word === "abcdef")).toBe(true);
  });
  it("no span: nothing spoken", () => {
    const m = markSpoken([{ text: "x", word: null, target: false }], null);
    expect(m).toEqual([{ text: "x", word: null, target: false, spoken: false }]);
  });
});

// Owner, 2026-11-05 01:27 JST: the card "devoir" (French top 1–500) showed
// this example with nothing highlighted, so it read as an example without the
// word. "dû" is devoir's past participle: the lemma file says so.
describe("the card's word inflected in its example, by the lemma file", () => {
  const DEVOIR = "J'ai donc dû choisir un autre métier et j'ai appris à piloter des avions.";
  const fileText = readFileSync(join(process.cwd(), "public/words/lemma/fr.txt"), "utf8");
  const lemmas = async (ws: string[]) => {
    const only = new Set<string>();
    for (const w of ws) for (const f of foldsOf(w, "fr")) only.add(f);
    return parseLemmas(fileText, only);
  };
  /** The example's headwords as /api/words/familiarity answers them. */
  const headsOf = async (text: string) => {
    const ws = wordsOf(text, "fr");
    const rec = await headsOfWords(ws, "fr", await lemmas(ws), lemmas);
    const m: HeadMap = new Map();
    recordHeads(m, "fr", rec);
    return m.get("fr")!;
  };

  it("highlights dû for devoir", async () => {
    const heads = await headsOf(DEVOIR);
    expect(marked(DEVOIR, targetSpans(DEVOIR, ["devoir"], "fr", heads))).toEqual(["dû"]);
  });

  it("finds nothing without the lemma data (the bug)", () => {
    expect(targetSpans(DEVOIR, ["devoir"], "fr")).toEqual([]);
  });

  it("keeps accents: the article du is no form of devoir", async () => {
    const text = "Il a mangé du pain parce qu'il a dû partir.";
    const heads = await headsOf(text);
    expect(marked(text, targetSpans(text, ["devoir"], "fr", heads))).toEqual(["dû"]);
    expect(marked(text, targetSpans(text, ["du"], "fr", heads))).toEqual(["du"]);
  });

  it("reaches the headword through a form of a form (due → dû → devoir)", async () => {
    const text = "La somme due est payée.";
    const heads = await headsOf(text);
    expect(heads.get("due")).toContain("devoir");
    expect(marked(text, targetSpans(text, ["devoir"], "fr", heads))).toEqual(["due"]);
  });

  it("finds other irregular forms, every one", async () => {
    const text = "Il doit partir, et je dois rester.";
    const heads = await headsOf(text);
    expect(marked(text, targetSpans(text, ["devoir"], "fr", heads))).toEqual(["doit", "dois"]);
  });

  it("lemmaHeads is exact: no guessed endings, no lost accents", async () => {
    const lem = await lemmas(["dû", "du"]);
    expect(lemmaHeads("dû", "fr", lem)).toEqual(["devoir"]);
    expect(lemmaHeads("du", "fr", lem)).toEqual([]);
    expect(lemmaHeads("dû", "fr", null)).toEqual([]);
  });
});
