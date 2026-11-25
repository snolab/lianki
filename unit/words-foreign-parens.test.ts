import { describe, expect, test } from "bun:test";
import { dropForeignParens, shownOffset } from "@/lib/words/foreign-parens";
import { sayParts } from "@/lib/words/say-parts";
import { spokenIn, type Spoken } from "@/lib/words/spoken-word";

const say = (text: string, lang = "en") => dropForeignParens(text, lang).text;

describe("dropForeignParens", () => {
  test("a Chinese translation in brackets after an English example is not read", () => {
    expect(say("I like apples. (我喜欢苹果。)")).toBe("I like apples.");
  });

  test("full-width brackets, and mixed half/full-width pairs", () => {
    expect(say("I like apples.（我喜欢苹果。）")).toBe("I like apples.");
    expect(say("I like apples. (我喜欢苹果。）")).toBe("I like apples.");
  });

  test("same-script notes are kept", () => {
    expect(say("Gonna go (informal).")).toBe("Gonna go (informal).");
    expect(say("猫が好き（ねこ）", "ja")).toBe("猫が好き（ねこ）");
    expect(say("Room (101) is free.")).toBe("Room (101) is free.");
  });

  test("the rule follows the card's language, not English: a Latin gloss on a Japanese line goes", () => {
    expect(say("猫が好きです。(I like cats.)", "ja")).toBe("猫が好きです。");
    expect(say("Кошка (猫) спит.", "ru")).toBe("Кошка спит.");
  });

  test("a bracket in the middle, and one at the start", () => {
    expect(say("The apple (苹果) is red.")).toBe("The apple is red.");
    expect(say("（苹果） An apple.")).toBe("An apple.");
  });

  test("mainly another script: a stray Latin letter in the translation does not keep it", () => {
    expect(say("Turn on the TV. (打开TV电视机。)")).toBe("Turn on the TV.");
  });

  test("nested and unbalanced brackets do not crash", () => {
    expect(say("Hi. (你好（问候）)")).toBe("Hi.");
    expect(say("Hi (there (friend)).")).toBe("Hi (there (friend)).");
    expect(say("Hi. (你好")).toBe("Hi. (你好");
    expect(say("Hi.) 你好）")).toBe("Hi.) 你好）");
    expect(say("((((")).toBe("((((");
    expect(say("")).toBe("");
  });

  test("shownOffset maps the spoken text back onto the shown one", () => {
    const shown = "The apple (苹果) is red.";
    const { text, cut } = dropForeignParens(shown, "en");
    const i = text.indexOf("is");
    expect(shown.slice(shownOffset(i, cut), shownOffset(i, cut) + 2)).toBe("is");
  });
});

describe("sayParts with words.speak.skipForeignParens", () => {
  const card = { term: "apple", back: "苹果", ex: "I like apples. (我喜欢苹果。)" };

  test("on (the default): the example is read without its translation", () => {
    expect(sayParts(card, "en", false, "zh").find((p) => p.kind === "example")?.text).toBe(
      "I like apples.",
    );
  });

  test("off: the whole example is read as before", () => {
    expect(sayParts(card, "en", false, "zh", false).find((p) => p.kind === "example")?.text).toBe(
      "I like apples. (我喜欢苹果。)",
    );
  });

  test("an example that is only a translation is left out", () => {
    const parts = sayParts({ term: "apple", back: "", ex: "（苹果）" }, "en", false, "zh");
    expect(parts.map((p) => p.kind)).toEqual(["word"]);
  });
});

describe("spokenIn over a shortened reading", () => {
  test("the lit word lands on the shown example, past a dropped bracket", () => {
    const shown = "The apple (苹果) is red.";
    const sp: Spoken = { text: "The apple is red.", lang: "en", span: [4, 9] };
    const [a, b] = spokenIn(sp, shown)!;
    expect(shown.slice(a, b)).toBe("apple");
    const sp2: Spoken = { text: "The apple is red.", lang: "en", span: [10, 12] };
    const [c, d] = spokenIn(sp2, shown)!;
    expect(shown.slice(c, d)).toBe("is");
  });

  test("another sentence still gets no span", () => {
    const sp: Spoken = { text: "I like pears.", lang: "en", span: [0, 1] };
    expect(spokenIn(sp, "I like apples. (我喜欢苹果。)")).toBeNull();
  });
});
