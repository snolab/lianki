import { describe, expect, it } from "bun:test";
import {
  examplePieces,
  looseKey,
  pieceRuns,
  targetSpans,
  type Span,
} from "@/lib/words/example-target";

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
