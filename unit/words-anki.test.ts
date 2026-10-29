import { describe, expect, test } from "bun:test";
import {
  buildEntries,
  decodeEntities,
  furiganaBase,
  furiganaKana,
  guessLang,
  guessMapping,
  hasFurigana,
  remapByName,
  stripAnki,
  type FieldMapping,
} from "@/lib/words/anki";

describe("stripAnki", () => {
  test("drops tags, media and keeps text", () => {
    expect(stripAnki('<div><b>chat</b> [sound:chat.mp3]<img src="cat.jpg"></div>')).toBe("chat");
  });
  test("line breaks become the separator", () => {
    expect(stripAnki("cat<br>feline<br/><div>pussycat</div>")).toBe("cat; feline; pussycat");
    expect(stripAnki("a<br>b", " / ")).toBe("a / b");
  });
  test("cloze keeps the answer, drops the hint", () => {
    expect(stripAnki("{{c1::Paris::capital}} is in {{c2::France}}")).toBe("Paris is in France");
  });
  test("ruby keeps the base text", () => {
    expect(stripAnki("<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>")).toBe("漢字");
  });
  test("scripts and styles vanish", () => {
    expect(stripAnki("<style>.x{}</style>word<script>alert(1)</script>")).toBe("word");
  });
  test("entities decode", () => {
    expect(stripAnki("caf&eacute; &amp; th&#233; &#x2014;&nbsp;ok")).toBe("caf&eacute; & thé — ok");
    expect(decodeEntities("&lt;&gt;&quot;&apos;&hellip;&FOO;&#0;")).toBe("<>\"'…&FOO;&#0;");
  });
});

describe("furigana", () => {
  test("base and kana", () => {
    expect(hasFurigana("日本[にほん]語[ご]")).toBe(true);
    expect(hasFurigana("plain")).toBe(false);
    expect(furiganaBase("日本[にほん] 語[ご]")).toBe("日本語");
    expect(furiganaKana("日本[にほん]語[ご]")).toBe("にほんご");
    expect(furiganaKana(" 食[た]べる")).toBe("たべる");
  });
});

describe("guessMapping", () => {
  test("Basic: Front / Back", () => {
    expect(guessMapping(["Front", "Back"])).toEqual({
      term: 0,
      back: 1,
      reading: -1,
      ex: -1,
      exTr: -1,
    });
  });
  test("Japanese core deck names", () => {
    const m = guessMapping([
      "Vocabulary-Kanji",
      "Vocabulary-Furigana",
      "Vocabulary-Kana",
      "Vocabulary-English",
      "Vocabulary-Audio",
      "Expression",
      "Reading",
      "Meaning",
      "Sentence",
      "Sentence-English",
      "Sentence-Audio",
    ]);
    expect(m.term).toBe(0);
    expect(m.reading).toBe(1);
    expect(m.back).toBe(3);
    expect(m.ex).toBe(8);
    expect(m.exTr).toBe(9);
  });
  test("Expression / Meaning / Reading", () => {
    expect(guessMapping(["Expression", "Meaning", "Reading", "Picture"])).toEqual({
      term: 0,
      back: 1,
      reading: 2,
      ex: -1,
      exTr: -1,
    });
  });
  test("Word / Definition / Example sentence translation", () => {
    const m = guessMapping(["Word", "Definition", "Example", "Example translation"]);
    expect(m).toEqual({ term: 0, back: 1, reading: -1, ex: 2, exTr: 3 });
  });
  test("unknown names fall back to the first text fields, skipping media", () => {
    expect(guessMapping(["Audio", "Spanisch", "Deutsch"])).toEqual({
      term: 1,
      back: 2,
      reading: -1,
      ex: -1,
      exTr: -1,
    });
  });
  test("a single field has no back", () => {
    expect(guessMapping(["Foo"])).toEqual({ term: 0, back: -1, reading: -1, ex: -1, exTr: -1 });
  });
});

describe("remapByName", () => {
  const m: FieldMapping = { term: 0, back: 1, reading: -1, ex: 2, exTr: -1 };
  test("by name, else by position, else none", () => {
    expect(remapByName(m, ["Front", "Back", "Example"], ["back", "front"])).toEqual({
      term: 1,
      back: 0,
      reading: -1,
      ex: -1,
      exTr: -1,
    });
    expect(remapByName(m, ["Front", "Back", "Example"], ["A", "B", "C"])).toEqual(m);
  });
});

describe("buildEntries", () => {
  const map: FieldMapping = { term: 0, back: 1, reading: 2, ex: 3, exTr: 4 };
  const note = (guid: string, ...fields: string[]) => ({ guid, fields, mapping: map });

  test("maps, strips and counts", () => {
    const r = buildEntries([
      note("a", "<b>hola</b>", "hello<br>hi", "", "¡Hola, Juan!", "Hi, Juan!"),
      note("b", '<img src="x.png">', "picture only"),
      note("c", "hola", "again"),
      note("d", "gato [sound:gato.mp3]", 'cat <img src="cat.jpg">'),
    ]);
    expect(r.entries).toEqual([
      { key: "a", term: "hola", back: "hello; hi", ex: "¡Hola, Juan!", exTr: "Hi, Juan!" },
      { key: "d", term: "gato", back: "cat" },
    ]);
    expect(r).toMatchObject({ empty: 1, duplicates: 1, images: 2, sounds: 1, over: 0 });
  });

  test("furigana in the term gives the reading", () => {
    const r = buildEntries([
      note("j", "食[た]べる", "to eat", "", "パンを 食[た]べる"),
      note("k", "飲[の]む", "to drink", "の.む[のむ]"),
      note("l", "水", "water", "水"),
    ]);
    expect(r.entries[0]).toEqual({
      key: "j",
      term: "食べる",
      back: "to eat",
      reading: "たべる",
      ex: "パンを食べる",
    });
    expect(r.entries[1].reading).toBe("のむ");
    expect(r.entries[2].reading).toBeUndefined();
  });

  test("long text is clipped; the cap leaves the rest out", () => {
    const r = buildEntries(
      [note("x", "a".repeat(300), "b".repeat(2000)), note("y", "two", "2")],
      1,
    );
    expect(r.entries[0].term.length).toBe(200);
    expect(r.entries[0].term.endsWith("…")).toBe(true);
    expect(r.entries[0].back.length).toBe(1000);
    expect(r.over).toBe(1);
  });

  test("an unmapped role or a missing field is empty", () => {
    const r = buildEntries([
      { guid: "z", fields: ["only"], mapping: { term: 0, back: 5, reading: -1, ex: -1, exTr: -1 } },
    ]);
    expect(r.entries).toEqual([{ key: "z", term: "only", back: "" }]);
  });
});

describe("guessLang", () => {
  test("the deck name first", () => {
    expect(guessLang("Spanish Top 5000", ["the"])).toBe("es");
    expect(guessLang("Core 2k/6k", [])).toBe("ja");
    expect(guessLang("HSK 1", [])).toBe("zh");
    expect(guessLang("TOEFL words", [])).toBe("en");
  });
  test("then the script", () => {
    expect(guessLang("Deck", ["食べる", "水"])).toBe("ja");
    expect(guessLang("Deck", ["水", "火"])).toBe("zh");
    expect(guessLang("Deck", ["사과"])).toBe("ko");
    expect(guessLang("Deck", ["привет"])).toBe("ru");
    expect(guessLang("Deck", ["سلام"])).toBe("ar");
    expect(guessLang("Deck", ["नमस्ते"])).toBe("hi");
    expect(guessLang("Deck", ["καλημέρα"])).toBe("el");
  });
  test("then a language's own letters", () => {
    expect(guessLang("Deck", ["niño", "año"])).toBe("es");
    expect(guessLang("Deck", ["straße", "schön"])).toBe("de");
    expect(guessLang("Deck", ["garçon", "être"])).toBe("fr");
    expect(guessLang("Deck", ["não", "pão"])).toBe("pt");
    expect(guessLang("Deck", ["cat", "dog"])).toBe("en");
  });
});
