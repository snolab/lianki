import { describe, expect, it } from "bun:test";
import { encodeForm, LEMMA_V, lemmasFromLex, parseLemmas } from "@/lib/read/lemma";
import { lemmasForWords, readLemmaFile } from "@/lib/read/lemma-server";
import { withLex } from "@/lib/read/progress";
import {
  bookProgress,
  cardIndex,
  countWords,
  foldsOf,
  hitOf,
  inDict,
  inKeys,
  normWord,
  parseWordStats,
  statsLemmas,
  stripElision,
  termKeys,
  unligate,
} from "@/lib/read/words";

const FILE = [
  "#lianki-lemmas v1 fr",
  "au",
  "cœur\t3oeur 0s",
  "manœuvre",
  "regarder\t2a 2ait 1",
  "œil\t3yeux 0s",
  "être\t4était 4fut 4sont",
  "est",
  "paquebot",
  "",
].join("\n");

describe("lemma file", () => {
  it("decodes forms from the headword", () => {
    const lem = parseLemmas(FILE);
    expect(lem.of("regarda")).toEqual(["regarder"]);
    expect(lem.of("regarde")).toEqual(["regarder"]);
    expect(lem.of("yeux")).toEqual(["œil"]);
    expect(lem.of("était")).toEqual(["être"]);
    expect(lem.of("chat")).toEqual([]);
    expect(lem.has("paquebot")).toBe(true);
    expect(lem.has("regarda")).toBe(false);
  });

  it("keeps only what a book's words need, short-kept forms included", () => {
    const lem = parseLemmas(FILE, new Set(["yeux", "regardait", "est"]));
    expect(lem.of("yeux")).toEqual(["œil"]);
    expect(lem.of("regardait")).toEqual(["regarder"]);
    expect(lem.of("regarda")).toEqual([]);
    expect(lem.has("est")).toBe(true);
    expect(lem.has("œil")).toBe(true);
    expect(lem.has("paquebot")).toBe(false);
  });

  it("round-trips through a book's stored entries", () => {
    const lem = parseLemmas(FILE, new Set(["yeux", "sont"]));
    const back = lemmasFromLex(JSON.parse(JSON.stringify(lem.toLex())));
    expect(back?.of("sont")).toEqual(["être"]);
    expect(back?.has("œil")).toBe(true);
    expect(lemmasFromLex({ ...lem.toLex(), v: LEMMA_V + 1 })).toBeNull();
    expect(lemmasFromLex(null)).toBeNull();
  });
});

// v2: the same entries, each form with its readings' tag sets.
const FILE_V2 = [
  "#lianki-lemmas v2 fr",
  "#tags past historic third-person singular first-person present plural masculine",
  "#sets 0.1.2.3 5.4.3,5.2.3 6.7",
  "regarder\t2a:0 1:1 1s",
  "œil\t3yeux:2 0s:2",
  "",
].join("\n");

describe("lemma file v2: grammatical tags per form", () => {
  it("returns each form's headword with its tags", () => {
    const lem = parseLemmas(FILE_V2);
    expect(lem.of("regarda")).toEqual(["regarder"]);
    expect(lem.forms("regarda")).toEqual([
      {
        lemma: "regarder",
        tags: ["past", "historic", "third-person", "singular"],
        sets: [["past", "historic", "third-person", "singular"]],
      },
    ]);
    expect(lem.forms("regarde")[0].sets).toEqual([
      ["present", "first-person", "singular"],
      ["present", "third-person", "singular"],
    ]);
    expect(lem.forms("regardes")).toEqual([{ lemma: "regarder", tags: [], sets: [] }]);
    expect(lem.forms("yeux")[0]).toMatchObject({ lemma: "œil", tags: ["plural", "masculine"] });
    expect(lem.forms("chat")).toEqual([]);
  });

  it("filters by a book's words as v1 does", () => {
    const lem = parseLemmas(FILE_V2, new Set(["yeux", "regarde"]));
    expect(lem.forms("yeux")[0].lemma).toBe("œil");
    expect(lem.forms("regarde")[0].tags).toEqual(["present", "first-person", "singular"]);
    expect(lem.of("regarda")).toEqual([]);
  });

  it("still reads a v1 file, without tags", () => {
    const lem = parseLemmas(FILE);
    expect(lem.forms("regarda")).toEqual([{ lemma: "regarder", tags: [], sets: [] }]);
    expect(lem.toLex().tags).toBeUndefined();
  });

  it("keeps the tags through a book's stored entries", () => {
    const lem = parseLemmas(FILE_V2, new Set(["regarde", "regardes", "yeux"]));
    const lex = JSON.parse(JSON.stringify(lem.toLex()));
    expect(lex.v).toBe(2);
    const back = lemmasFromLex(lex)!;
    expect(back.forms("regarde")).toEqual(lem.forms("regarde"));
    expect(back.forms("yeux")).toEqual(lem.forms("yeux"));
    expect(back.forms("regardes")).toEqual([{ lemma: "regarder", tags: [], sets: [] }]);
    // An entry from a v1 book (no tags) is stored again, not read.
    expect(lemmasFromLex({ ...lex, v: 1 })).toBeNull();
    // Ids outside the tag list are dropped, not shown as "undefined".
    const bad = lemmasFromLex({ v: LEMMA_V, of: [["x", ["y"], ["0.99"]]], heads: [], tags: ["a"] });
    expect(bad?.forms("x")).toEqual([{ lemma: "y", tags: ["a"], sets: [["a"]] }]);
  });

  it("encodes forms the parser reads back", () => {
    expect(encodeForm("regarder", "regarda")).toBe("2a");
    expect(encodeForm("regarder", "regarda", 0)).toBe("2a:0");
    expect(encodeForm("œil", "yeux", 12)).toBe("3yeux:12");
    const long = "anticonstitutionnellement";
    expect(encodeForm(long, "anti", 3)).toBe("~21~:3");
    const lem = parseLemmas(
      `#lianki-lemmas v2 fr\n#tags plural\n#sets 0\n${long}\t${encodeForm(long, "anti", 0)}\n`,
    );
    expect(lem.forms("anti")).toEqual([{ lemma: long, tags: ["plural"], sets: [["plural"]] }]);
  });
});

describe("French normalisation", () => {
  it("strips elided clitics with either apostrophe, keeps accents", () => {
    expect(normWord("l’homme", "fr")).toBe("homme");
    expect(normWord("Qu'il", "fr")).toBe("il");
    expect(normWord("jusqu’ici", "fr")).toBe("ici");
    expect(normWord("aujourd’hui", "fr")).toBe("aujourd'hui");
    expect(normWord("Été", "fr")).toBe("été");
    expect(stripElision("s'écria", "fr")).toBe("écria");
    expect(stripElision("s'écria", "en")).toBe("s'écria");
  });

  it("folds the œ/æ ligatures to a shared key", () => {
    expect(unligate("cœur", "fr")).toBe("coeur");
    expect(unligate("cœur", "de")).toBe("cœur");
    expect(foldsOf("cœur", "fr")).toContain("coeur");
    expect(termKeys("cœur", null, "fr")).toContain("coeur");
    expect(termKeys("s'écrier", null, "fr")).toContain("écrier");
  });

  it("reads names after abbreviations and elisions", () => {
    const s = countWords(
      [
        "Il parlait à Mrs. Aouda depuis longtemps.",
        "Le voyage vers l'Angleterre dura dix jours, et l'Angleterre était loin.",
        "Puis il vit M. Fogg sur le quai.",
      ],
      "fr",
    );
    expect(s.names).toContain("aouda");
    expect(s.names).toContain("angleterre");
    expect(s.names).toContain("fogg");
  });
});

describe("matching with lemmas", () => {
  const lem = parseLemmas(FILE);
  it("finds a lemma's card from any of its forms", () => {
    const idx = cardIndex([{ term: "regarder", lang: "fr", interval: 400, stability: 400 }]);
    expect(hitOf("regardait", "fr", idx)).toBeNull();
    expect(hitOf("regardait", "fr", idx, lem)?.mastered).toBe(true);
    expect(inKeys("yeux", "fr", new Set(["œil"]), lem)).toBe(true);
    expect(inKeys("coeur", "fr", new Set(termKeys("cœur", null, "fr")))).toBe(true);
  });

  it("lets the dictionary, when it knows a word, replace guessed endings", () => {
    const l = parseLemmas("#lianki-lemmas v1 fr\ncourse\ncourir\t2s\n");
    const idx = cardIndex([{ term: "courir", lang: "fr", interval: 400, stability: 400 }]);
    expect(foldsOf("course", "fr", l)).toEqual(["course"]);
    expect(hitOf("course", "fr", idx, l)).toBeNull();
    expect(hitOf("cours", "fr", idx, l)?.mastered).toBe(true);
    // Unknown to the dictionary: the cheap folds still apply.
    expect(foldsOf("chats", "fr", l)).toContain("chat");
  });

  it("tells dictionary words from unrecognised ones", () => {
    expect(inDict("paquebots", "fr", lem)).toBe(true);
    expect(inDict("fut", "fr", lem)).toBe(true);
    expect(inDict("au", "fr", lem)).toBe(true);
    expect(inDict("sutty", "fr", lem)).toBe(false);
    expect(inDict("paquebot", "fr", null)).toBe(false);
  });

  it("counts coverage through forms", () => {
    const stats = countWords(["Il regardait. Il regarda. Il regarde."], "fr");
    const idx = cardIndex([{ term: "regarder", lang: "fr", interval: 400, stability: 400 }]);
    expect(bookProgress(stats, idx).masteredTokens).toBe(0);
    expect(bookProgress(stats, idx, lem).masteredTokens).toBe(3);
  });
});

describe("the shipped French file", () => {
  it("maps common forms and knows rarer headwords", async () => {
    const words = ["était", "yeux", "regarda", "au", "aux", "cette", "paquebot", "coeur", "fut"];
    const lem = await lemmasForWords("fr", words);
    expect(lem).not.toBeNull();
    expect(lem!.of("était")).toContain("être");
    expect(lem!.of("yeux")).toContain("œil");
    expect(lem!.of("regarda")).toContain("regarder");
    expect(lem!.of("fut")).toContain("être");
    expect(lem!.of("coeur")).toContain("cœur");
    expect(lem!.of("cette")).toContain("ce");
    for (const w of words) expect(inDict(w, "fr", lem)).toBe(true);
    expect(await lemmasForWords("de", words)).toBeNull();
  });

  it("tags the forms with their grammar", async () => {
    const lem = (await lemmasForWords("fr", ["regarda", "yeux", "était"]))!;
    expect(lem.forms("regarda").find((f) => f.lemma === "regarder")?.tags).toEqual(
      expect.arrayContaining(["past", "historic", "third-person", "singular"]),
    );
    expect(lem.forms("yeux").find((f) => f.lemma === "œil")?.tags).toContain("plural");
    expect(lem.forms("était").find((f) => f.lemma === "être")?.tags).toContain("imperfect");
  });

  it("tags Finnish forms with case and person", async () => {
    const lem = (await lemmasForWords("fi", ["talossa", "olen"]))!;
    expect(lem.forms("talossa").find((f) => f.lemma === "talo")?.tags).toEqual(
      expect.arrayContaining(["inessive", "singular"]),
    );
    expect(lem.forms("olen").find((f) => f.lemma === "olla")?.tags).toEqual(
      expect.arrayContaining(["first-person", "present", "singular"]),
    );
  });

  it("stores the entries with a book's words, once", async () => {
    const stats = countWords(["Ses yeux regardaient le paquebot."], "fr");
    const withL = await withLex(stats);
    expect(withL.lex?.v).toBe(LEMMA_V);
    expect(await withLex(withL)).toBe(withL);
    const parsed = parseWordStats(JSON.parse(JSON.stringify(withL)))!;
    expect(statsLemmas(parsed)?.of("yeux")).toContain("œil");
    const again = await withLex(stats);
    expect(again.lex).toEqual(withL.lex);
    const en = countWords(["The eyes."], "en");
    expect(await withLex(en)).toBe(en);
  });
});

describe("reading the lemma file on the server", () => {
  it("takes the Worker's assets, else public/, else nothing", async () => {
    const assets = {
      fetch: async (req: Request) => {
        expect(new URL(req.url).pathname).toBe("/words/lemma/fr.txt");
        return new Response("#lianki-lemmas v1 fr\nchat\n");
      },
    };
    expect(await readLemmaFile("fr", assets)).toContain("chat");
    const down = { fetch: async () => new Response("", { status: 404 }) };
    expect((await readLemmaFile("fr", down))?.startsWith("#lianki-lemmas v2 fr")).toBe(true);
    const broken = { fetch: async () => Promise.reject(new Error("down")) };
    expect(await readLemmaFile("xx", broken)).toBeNull();
  });

  it("reads gzip as well as plain text", async () => {
    const { gzipSync } = await import("node:zlib");
    const gz = gzipSync("#lianki-lemmas v1 fr\nchat\n");
    const assets = { fetch: async () => new Response(gz) };
    expect(await readLemmaFile("fr", assets)).toContain("chat");
  });
});
