import { describe, expect, it } from "bun:test";
import {
  MAX_BYTES,
  MAX_WORDS,
  WordListError,
  headerColumns,
  listNameFrom,
  normTerm,
  parseWordList,
  sniffFormat,
  splitKnown,
  splitRows,
  termKey,
  toEntry,
} from "@/lib/import/wordlist";

// docs/import-material.md, M1: a .txt/.csv word list → /words entries.

describe("parseWordList: one word per line", () => {
  it("takes each line as a term, skipping blank lines and list markers", () => {
    const p = parseWordList("apple\n\n  banana  \n1. cherry\n- date\n• fig\n");
    expect(p.format).toBe("lines");
    expect(p.rows.map((r) => r.term)).toEqual(["apple", "banana", "cherry", "date", "fig"]);
    expect(p.rows.map((r) => r.line)).toEqual([1, 3, 4, 5, 6]);
    expect(p.skippedCount).toBe(0);
  });

  it("keeps phrases with commas when the commas are not a column pattern", () => {
    const p = parseWordList("by the way\nin spite of, despite\nmake up\nlook after\nget over\n");
    expect(p.format).toBe("lines");
    expect(p.rows[1].term).toBe("in spite of, despite");
  });

  it("works for any script: the same rules, no language branch", () => {
    const p = parseWordList("食べる\n학교\nпривет\nمرحبا\nΚαλημέρα\n");
    expect(p.rows.map((r) => r.term)).toEqual(["食べる", "학교", "привет", "مرحبا", "Καλημέρα"]);
  });

  it("skips duplicates by normalized form, counting them", () => {
    const p = parseWordList("Apple\napple\nAPPLE \ncafe\u0301\ncafé\n");
    expect(p.rows.map((r) => r.term)).toEqual(["Apple", "café"]);
    expect(p.skippedBy.duplicate).toBe(3);
    expect(p.skipped[0]).toEqual({ line: 2, reason: "duplicate" });
  });

  it("strips a BOM and CRLF", () => {
    const p = parseWordList("\uFEFFone\r\ntwo\r\n");
    expect(p.rows.map((r) => r.term)).toEqual(["one", "two"]);
  });
});

describe("parseWordList: CSV / TSV", () => {
  it("detects a header and maps word / meaning / example columns in any order", () => {
    const p = parseWordList(
      'Example,Word,Meaning\n"I ate an apple, then left.",apple,a fruit\nNice day,day,a 24-hour period\n',
      "list.csv",
    );
    expect(p.format).toBe("csv");
    expect(p.header).toBe(true);
    expect(p.rows[0]).toEqual({
      line: 2,
      term: "apple",
      back: "a fruit",
      ex: "I ate an apple, then left.",
    });
  });

  it("reads header names in other languages from the alias table", () => {
    expect(headerColumns(["单词", "释义", "例句"])).toMatchObject({ term: 0, back: 1, ex: 2 });
    expect(headerColumns(["Wort", "Bedeutung"])).toMatchObject({ term: 0, back: 1 });
    expect(headerColumns(["単語", "読み", "意味"])).toMatchObject({
      term: 0,
      reading: 1,
      back: 2,
    });
    expect(headerColumns(["palabra", "significado", "ejemplo", "traducción del ejemplo"])).toEqual({
      term: 0,
      back: 1,
      reading: -1,
      ex: 2,
      exTr: 3,
    });
  });

  it("does not take a data row as a header", () => {
    expect(headerColumns(["apple", "a fruit"])).toBeNull();
    // "word" is a real word too: one named cell next to data is data.
    expect(headerColumns(["word", "a unit of language"])).toBeNull();
  });

  it("without a header: term, meaning, example", () => {
    const p = parseWordList("hola\thello\t¡Hola, amigo!\nadiós\tgoodbye\n");
    expect(p.format).toBe("tsv");
    expect(p.header).toBe(false);
    expect(p.rows[0]).toMatchObject({ term: "hola", back: "hello", ex: "¡Hola, amigo!" });
    expect(p.rows[1]).toMatchObject({ term: "adiós", back: "goodbye" });
    expect(p.rows[1].ex).toBeUndefined();
  });

  it("sniffs semicolons (spreadsheet exports in comma-decimal locales)", () => {
    const p = parseWordList("Haus;house\nBaum;tree\nHund;dog\n", "de.csv");
    expect(p.format).toBe("ssv");
    expect(p.rows.map((r) => r.back)).toEqual(["house", "tree", "dog"]);
  });

  it("keeps quoted line breaks and doubled quotes inside one field", () => {
    const rows = splitRows('a,"say ""hi""\nthere"\nb,c\n', ",");
    expect(rows).toEqual([
      { line: 1, cells: ["a", 'say "hi"\nthere'] },
      { line: 3, cells: ["b", "c"] },
    ]);
  });

  it("skips rows with no term and over-long terms", () => {
    const long = "x".repeat(201);
    const p = parseWordList(`,meaning only\n${long},y\nok,fine\n`);
    expect(p.rows.map((r) => r.term)).toEqual(["ok"]);
    expect(p.skippedBy).toMatchObject({ "no-term": 1, "too-long": 1 });
  });

  it("clips a long meaning instead of dropping the word", () => {
    const p = parseWordList(`w1,${"m".repeat(1500)}\nw2,b\n`);
    expect(p.rows[0].back.length).toBe(1000);
    expect(p.rows[0].back.endsWith("…")).toBe(true);
  });

  it("the file name only breaks ties", () => {
    expect(sniffFormat("a\tb,c\nd\te,f\n", "x.csv")).toBe("csv");
    expect(sniffFormat("a\tb,c\nd\te,f\n", "x.tsv")).toBe("tsv");
    expect(sniffFormat("just words\nmore words\n", "x.csv")).toBe("lines");
  });
});

describe("parseWordList: caps and errors", () => {
  it("refuses more than MAX_BYTES", () => {
    expect(() => parseWordList("a\n".repeat(MAX_BYTES / 2 + 1))).toThrow(WordListError);
  });

  it("refuses an empty input and a binary file", () => {
    expect(() => parseWordList("  \n\n")).toThrow("No words found");
    expect(() => parseWordList("PK\u0003\u0004\u0000\u0000junk")).toThrow("Not a text file");
  });

  it("keeps at most MAX_WORDS words and counts the rest", () => {
    const text = Array.from({ length: MAX_WORDS + 5 }, (_, i) => `w${i}`).join("\n");
    const p = parseWordList(text);
    expect(p.rows.length).toBe(MAX_WORDS);
    expect(p.skippedBy["over-limit"]).toBe(5);
    expect(p.skipped.length).toBeLessThanOrEqual(50);
  });
});

describe("keys, known words, names", () => {
  it("termKey is stable per normalized term and fits the 64-char key column", () => {
    expect(termKey("Apple")).toBe(termKey(" apple "));
    expect(termKey("apple")).not.toBe(termKey("apples"));
    expect(termKey("apple").length).toBeLessThanOrEqual(64);
    const keys = new Set(Array.from({ length: 20000 }, (_, i) => termKey(`word${i}`)));
    expect(keys.size).toBe(20000);
  });

  it("splitKnown compares normalized forms", () => {
    const { fresh, have } = splitKnown([{ term: "Apple" }, { term: "pear" }], new Set(["apple"]));
    expect(have.map((r) => r.term)).toEqual(["Apple"]);
    expect(fresh.map((r) => r.term)).toEqual(["pear"]);
    expect(normTerm("  Big   Cat ")).toBe("big cat");
  });

  it("toEntry leaves out empty optional fields", () => {
    expect(toEntry({ term: "a", back: "" })).toEqual({ key: termKey("a"), term: "a", back: "" });
  });

  it("listNameFrom drops the folder and extension", () => {
    expect(listNameFrom("C:\\Users\\me\\GRE_words.csv")).toBe("GRE words");
    expect(listNameFrom("list.txt")).toBe("list");
  });
});
