import { describe, expect, test } from "bun:test";
import { BACK_ORDER, backParts } from "@/lib/words/row-layout";
import { sayParts } from "@/lib/words/say-parts";
import {
  exampleSegments,
  famMark,
  missingWords,
  recordHits,
  type FamMap,
} from "@/lib/words/example-marks";
import { segmentsOf } from "@/lib/read/words";
import { examplesOf, pickExample, withPickedExample } from "@/lib/words/example-pick";

describe("row order: example first (owner, 2026-11-03)", () => {
  test("the back is the example, then the meaning", () => {
    expect(BACK_ORDER).toEqual(["example", "meaning"]);
    expect(backParts({ ex: "Ma maison est grande." })).toEqual(["example", "meaning"]);
  });

  test("no example: the meaning takes its place", () => {
    expect(backParts({})).toEqual(["meaning"]);
    expect(backParts({ ex: "" })).toEqual(["meaning"]);
  });

  test("a phrase's note sits where an example would", () => {
    expect(backParts({ note: "polite" })).toEqual(["example", "meaning"]);
  });

  test("read aloud follows the shown order, in every language", () => {
    for (const [term, back, ex, lang] of [
      ["maison", "house", "Ma maison est grande.", "fr"],
      ["Haus", "house", "Das Haus ist groß.", "de"],
      ["家", "house", "这是我的家。", "zh"],
    ])
      expect(sayParts({ term, back, ex }, lang, false, "en").map((p) => p.kind)).toEqual([
        "word",
        ...BACK_ORDER,
      ]);
  });
});

describe("familiarity marks in examples", () => {
  test("segments join back into the sentence, words normalised", () => {
    const text = "L'homme regarde les chats.";
    const segs = segmentsOf(text, "fr");
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs.filter((s) => s.word).map((s) => s.word)).toEqual([
      "homme",
      "regarde",
      "les",
      "chats",
    ]);
  });

  test("a card's level gives the mark; mastered and no card stay plain", () => {
    expect(famMark(undefined)).toBe(null);
    expect(famMark(null)).toBe(null);
    expect(famMark([0.2, 0])).toBe("weak");
    expect(famMark([0.8, 0])).toBe("learning");
    expect(famMark([1, 1])).toBe(null);
  });

  test("each word is asked once per language, then remembered", () => {
    const known: FamMap = new Map();
    const items = [
      { ex: "Le chat dort.", lang: "fr" },
      { ex: "Le chien dort.", lang: "fr-FR" },
      { ex: "The cat sleeps.", lang: "en" },
      { lang: "en" },
    ];
    const want = missingWords(items, known);
    expect(want.get("fr")?.sort()).toEqual(["chat", "chien", "dort", "le"]);
    expect(want.get("en")?.sort()).toEqual(["cat", "sleeps", "the"]);
    recordHits(known, "fr", want.get("fr")!, { chat: [0.3, 0] });
    expect(known.get("fr")?.get("chat")).toEqual([0.3, 0]);
    expect(known.get("fr")?.get("chien")).toBe(null);
    expect(missingWords(items, known).has("fr")).toBe(false);
  });

  test("an example is segmented once", () => {
    expect(exampleSegments("Le chat dort.", "fr")).toBe(exampleSegments("Le chat dort.", "fr"));
  });
});

describe("one example per showing", () => {
  const exs = [{ ex: "A.", exTr: "a" }, { ex: "B.", exTr: "b" }, { ex: "C." }];
  test("an entry's examples: ex first, then the alternatives, no repeats", () => {
    expect(examplesOf({ ex: "A.", exTr: "a", exs: [exs[0], exs[1]] }).map((x) => x.ex)).toEqual([
      "A.",
      "B.",
    ]);
    expect(examplesOf({})).toEqual([]);
  });
  test("random, never the last one shown when there is another", () => {
    for (const r of [0, 0.5, 0.99]) expect(pickExample(exs, "B.", () => r)?.ex).not.toBe("B.");
    expect(pickExample([exs[0]], "A.")?.ex).toBe("A.");
    expect(pickExample([], undefined)).toBeUndefined();
  });
  test("one example: the entry is unchanged", () => {
    const e = { term: "x", ex: "A.", exTr: "a" };
    expect(withPickedExample(e, "k")).toBe(e);
  });
  test("the pick carries its own translation", () => {
    const e = withPickedExample({ term: "x", ex: "A.", exTr: "a", exs }, "k", () => 0.99);
    expect(e.ex).toBe("C.");
    expect(e.exTr).toBeUndefined();
  });
});
