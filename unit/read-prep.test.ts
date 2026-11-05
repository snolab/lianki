// The import pipeline (lib/read/prep.ts, lib/read/lang-detect.ts,
// lib/read/polish.ts): detection, bite size, per-line languages, the polish
// check. Made-up text only.
import { describe, expect, it } from "bun:test";
import {
  detectLangs,
  langAt,
  langIn,
  primaryLang,
  toRuns,
  unitLang,
  checkRuns,
} from "@/lib/read/lang-detect";
import {
  biteSize,
  checkShape,
  cutAtPauses,
  detectBook,
  detectShape,
  fillerCount,
} from "@/lib/read/prep";
import { applyPolish, checkPolish, polishChunks, polishMessages } from "@/lib/read/polish";
import { readerBook } from "@/lib/read/reader-book";
import { sentenceCarryMap } from "@/lib/read/sentence-cards";
import { bookHash, readingLoad, segmentBook } from "@/lib/read/units";
import { bookMetaOf, parseBookMeta } from "@/lib/read/book";
import { parseGdocHtml } from "@/lib/gdoc/parse";
import { wordLang } from "@/lib/read/words";
import { readLang } from "@/lib/read/player";

// A made-up raw transcript: short utterances, fillers, lower-case starts.
const UTTER = [
  "so um we went to the lake on saturday.",
  "uh the water was really cold.",
  "and then my brother he said we should swim anyway.",
  "um I was not sure about that.",
  "but we did it and it was fun.",
];
const transcript = (n: number) =>
  Array.from({ length: n }, (_, i) => UTTER[i % UTTER.length]).join(" ");

const essay = [
  "The lake lies north of the town. It is cold all year.",
  "Visitors swim there in summer. Most of them come from the city.",
  "In winter the lake freezes. Children skate on it.",
];

describe("language per unit", () => {
  it("names a unit by its heaviest language, from the data files", () => {
    expect(unitLang("The cat sat on the mat.", "en")).toBe("en");
    expect(unitLang("猫はマットの上に座った。", "en")).toBe("ja");
    expect(unitLang("猫坐在垫子上。", "en")).toBe("zh");
    expect(unitLang("고양이가 매트에 앉았다.", "en")).toBe("ko");
    // One foreign word does not change a sentence's language.
    expect(unitLang("We ate ramen (ラーメン) at the station.", "en")).toBe("en");
    expect(unitLang("…", "en")).toBeNull();
  });

  it("detects runs in a bilingual text; Han beside kana is Japanese; an aside keeps its neighbours'", () => {
    const units = [
      "The cat sat on the mat and looked at the bird.",
      "猫はマットの上に座って、鳥を見ていました。",
      "日本。",
      "それから猫は眠りました。",
      "Then the cat slept for a while in the sun.",
    ];
    expect(detectLangs(units)).toEqual(["en", "ja", "ja", "ja", "en"]);
    expect(detectLangs(["Hello there, how are you today?", "OK.", "I am fine, and you?"])).toEqual([
      "en",
      "en",
      "en",
    ]);
  });

  it("the primary language is the majority, not the first script seen", () => {
    const doc = [essay.join(" "), essay.join(" "), "少しだけ日本語。"];
    expect(primaryLang(doc)).toBe("en");
    expect(wordLang(undefined, doc)).toBe("en");
    expect(readLang(undefined, doc.join(" "))).toBe("en");
    expect(wordLang(undefined, ["今日はいい天気ですね"])).toBe("ja");
  });

  it("runs: stored, looked up, checked", () => {
    const runs = toRuns(["en", "en", "ja", "en"]);
    expect(runs).toEqual([
      [0, "en"],
      [2, "ja"],
      [3, "en"],
    ]);
    expect([0, 1, 2, 3].map((l) => langAt(runs, l, "x"))).toEqual(["en", "en", "ja", "en"]);
    expect(langAt(undefined, 5, "fr")).toBe("fr");
    expect(checkRuns(runs, 4)).toEqual(runs);
    expect(
      checkRuns(
        [
          [1, "en"],
          [0, "ja"],
        ],
        null,
      ),
    ).toBeNull();
    expect(checkRuns([[0, "<b>"]], null)).toBeNull();
  });

  it("a word's language among the book's", () => {
    expect(langIn("swim", ["ja", "en"], "ja")).toBe("en");
    expect(langIn("泳ぐ", ["ja", "en"], "ja")).toBe("ja");
    // Han alone in a Japanese book is Japanese.
    expect(langIn("湖", ["ja", "en"], "ja")).toBe("ja");
    expect(langIn("lake", ["en"], "en")).toBe("en");
  });
});

describe("detectShape", () => {
  it("a raw transcript: one long paragraph with transcript signs", () => {
    const s = detectShape([transcript(150)], new Set());
    expect(s.raw).toBe(true);
    expect(s.signals.longParas).toBeGreaterThan(0.5);
    expect(s.signals.lowerStarts).toBeGreaterThan(0.5);
    expect(fillerCount("Um, so uh, the umbrella")).toBe(2);
  });

  it("a structured text is not raw, even when long", () => {
    expect(detectShape(essay, new Set()).raw).toBe(false);
    const long = Array.from({ length: 40 }, () => essay.join(" ")).join(" ");
    // Long, but written: capitals, full stops, no fillers.
    expect(detectShape([long], new Set()).raw).toBe(false);
  });

  it("mixed languages, heaviest first; stored shapes are checked", () => {
    const s = detectShape([essay.join(" "), "猫はマットの上に座った。"], new Set());
    expect(s.mixed).toBe(true);
    expect(s.langs[0]).toBe("en");
    expect(checkShape(s)).toEqual(s);
    expect(checkShape({ ...s, v: 0 })).toBeNull();
    expect(checkShape("raw")).toBeNull();
  });

  it("detectBook joins a long paragraph split at import", () => {
    const t = transcript(150);
    const half = t.indexOf(" ", t.length / 2);
    const s = detectBook({
      lines: [t.slice(0, half), t.slice(half + 1)],
      headings: [],
      continues: [1],
    });
    expect(s.raw).toBe(true);
  });
});

describe("biteSize", () => {
  it("leaves a well-made book as it is", () => {
    const b = biteSize({
      title: "t",
      lines: essay,
      chapters: [{ title: "t", start: 0 }],
      headings: [],
    });
    expect(b.lines).toEqual(essay);
    expect(b.langs).toBeUndefined();
  });

  it("cuts a long transcript into pieces near the lower end of the 1–3 minute rule", () => {
    const wps = 2;
    const text = transcript(200);
    const total = readingLoad(text, "en");
    const b = biteSize(
      { title: "t", lines: [text], chapters: [{ title: "t", start: 0 }], headings: [] },
      { wordsPerSecond: wps, raw: true },
    );
    expect(b.lines.length).toBeGreaterThan(2);
    for (const l of b.lines) expect(readingLoad(l, "en")).toBeLessThanOrEqual(wps * 60 * 1.6);
    // Nothing lost: the same words in the same order.
    expect(b.lines.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    expect(b.lines.reduce((n, l) => n + readingLoad(l, "en"), 0)).toBe(total);
  });

  it("a sentence with no punctuation is cut at its pauses", () => {
    const run = Array.from({ length: 60 }, (_, i) => (i % 7 === 6 ? "word, um" : "word")).join(" ");
    const cuts = cutAtPauses(run, "en", 10);
    expect(cuts.length).toBeGreaterThan(2);
    const b = biteSize(
      { title: "t", lines: [run], chapters: [], headings: [] },
      { wordsPerSecond: 10 / 60, raw: true },
    );
    expect(b.lines.length).toBeGreaterThan(2);
  });

  it("splits where the language changes, each line with its own; headings, chapters and marks follow", () => {
    const lines = [
      "Chapter one",
      "The cat sat on the mat and looked at the bird. 猫はマットの上に座って、鳥を見ていました。それから猫は眠りました。",
      "Then the cat slept.",
    ];
    const b = biteSize({
      title: "t",
      lines,
      chapters: [{ title: "Chapter one", start: 0 }],
      headings: [0],
      marks: [[2, 9, 12, "em"]],
      breaks: [],
      continues: [],
    });
    expect(b.lines).toEqual([
      "Chapter one",
      "The cat sat on the mat and looked at the bird.",
      "猫はマットの上に座って、鳥を見ていました。それから猫は眠りました。",
      "Then the cat slept.",
    ]);
    expect(b.headings).toEqual([0]);
    expect(b.chapters).toEqual([{ title: "Chapter one", start: 0 }]);
    expect(b.langs).toEqual([
      [0, "en"],
      [2, "ja"],
      [3, "en"],
    ]);
    expect(b.marks).toEqual([[3, 9, 12, "em"]]);
    // Stored and read back with the book's meta.
    const meta = parseBookMeta(JSON.stringify(bookMetaOf(b, { source: "gdoc" })));
    expect(meta?.langs).toEqual(b.langs);
  });

  it("a Docs line break (soft return) is its own paragraph", () => {
    const html =
      "<html><body><p><span>First line of a turn.</span><br><span>Second line.\u000bThird line.</span></p></body></html>";
    const parsed = parseGdocHtml(html, "Doc");
    expect(parsed.lines).toEqual(["First line of a turn.", "Second line.", "Third line."]);
    const b = biteSize(
      { ...parsed, chapters: parsed.chapters, headings: parsed.headings },
      { splitBreaks: true },
    );
    expect(b.lines).toEqual(parsed.lines);
    expect(b.breaks).toEqual([]);
  });
});

describe("polish", () => {
  const raw = ["so um we went to the lake it was cold", "Heading", "then we swam and it was fun"];

  it("chunks the body, never across a heading", () => {
    const c = polishChunks(raw, new Set([1]), 1000);
    expect(c.map((x) => x.lines)).toEqual([[0], [2]]);
  });

  it("accepts punctuation, case, paragraphs and dropped fillers; refuses a changed word", () => {
    expect(checkPolish(raw[0], "So we went to the lake.\n\nIt was cold.")).toEqual([
      "So we went to the lake.",
      "It was cold.",
    ]);
    expect(checkPolish(raw[0], "So we went to the sea. It was cold.")).toBeNull();
    expect(checkPolish(raw[0], "So we went to the lake. It was very cold.")).toBeNull();
    expect(checkPolish(raw[0], "")).toBeNull();
  });

  it("applies the passing chunks, keeps the failing ones raw, headings and chapters in place", () => {
    const book = {
      title: "t",
      lines: raw,
      headings: [1],
      chapters: [
        { title: "t", start: 0 },
        { title: "Heading", start: 1 },
      ],
    };
    const chunks = polishChunks(raw, new Set([1]), 1000);
    const out = applyPolish(book, chunks, [["So we went to the lake.", "It was cold."], null]);
    expect(out.lines).toEqual(["So we went to the lake.", "It was cold.", "Heading", raw[2]]);
    expect(out.headings).toEqual([2]);
    expect(out.chapters.map((c) => c.start)).toEqual([0, 2]);
  });

  it("asks the model to keep every word, and marks stay on lines kept raw", () => {
    const m = polishMessages("so um we went");
    expect(m[0].content).toContain("Never add, remove, reorder or replace a word");
    expect(m[1].content).toBe("so um we went");
    const book = {
      title: "t",
      lines: ["a raw line", "kept line"],
      headings: [],
      chapters: [{ title: "t", start: 0 }],
      marks: [
        [0, 0, 1, "em"],
        [1, 0, 4, "strong"],
      ] as [number, number, number, "em" | "strong"][],
    };
    const chunks = [
      { lines: [0], text: "a raw line" },
      { lines: [1], text: "kept line" },
    ];
    const out = applyPolish(book, chunks, [["A raw line."], null]);
    expect(out.marks).toEqual([[1, 0, 4, "strong"]]);
  });

  it("a mixed book's reader cuts each line in its own language", async () => {
    const lines = ["The cat sat.", "猫が座った。"];
    const meta = bookMetaOf(
      {
        title: "t",
        lang: "en",
        lines,
        chapters: [],
        headings: [],
        langs: [
          [0, "en"],
          [1, "ja"],
        ],
      },
      { source: "gdoc" },
    );
    const rb = readerBook(lines, meta, await bookHash(lines));
    expect(rb.mixed).toBe(true);
    expect(rb.langs).toEqual(["en", "ja"]);
    expect([rb.langOf(0), rb.langOf(1)]).toEqual(["en", "ja"]);
    expect(rb.chapters).toEqual([[0, 2]]);
    expect(rb.words().dict.length).toBeGreaterThan(0);
  });

  it("sentence cards follow their words to the new ids", () => {
    const before = ["so we went to the lake. it was cold. then we swam."];
    const after = ["So we went to the lake.", "It was cold. Then we swam."];
    const a = segmentBook(before, "en", "a");
    const b = segmentBook(after, "en", "b");
    const map = sentenceCarryMap(a, before, b, after);
    // Every new sentence gets the card of the raw sentence its words came from.
    expect(map.map(([, , nl, ni]) => [nl, ni])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(map.every(([ol]) => ol === 0)).toBe(true);
    // A changed text: only sentences with the same words, in order.
    const edited = ["So we went to the lake.", "It was warm. Then we swam."];
    const e = segmentBook(edited, "en", "e");
    const em = sentenceCarryMap(b, after, e, edited);
    expect(em.map(([ol, oi, nl, ni]) => [ol, oi, nl, ni])).toEqual([
      [0, 0, 0, 0],
      [1, 1, 1, 1],
    ]);
  });
});
