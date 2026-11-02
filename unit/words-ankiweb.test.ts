import { describe, expect, test } from "bun:test";
import {
  ANKIWEB_CHECKED,
  ANKIWEB_DECKS,
  ANKIWEB_INFO_RE,
  ANKIWEB_SEARCH_URL,
  ankiWebInfoUrl,
  ankiWebSearchUrl,
  matchDeck,
  parseAnkiWebUrl,
  searchDecks,
} from "@/lib/words/ankiweb";
import { IMPORT_LANGS } from "@/lib/words/anki";

// The curated AnkiWeb decks on /words/import: links and our own one-line
// descriptions only (docs/wordlists-pipeline.md §1a, §3a).

describe("curated deck data", () => {
  test("10–20 decks, unique numeric ids, checked on an ISO date", () => {
    expect(ANKIWEB_DECKS.length).toBeGreaterThanOrEqual(10);
    expect(ANKIWEB_DECKS.length).toBeLessThanOrEqual(20);
    const ids = ANKIWEB_DECKS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^\d{1,12}$/);
    expect(ANKIWEB_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("every deck has a language we import, a level and one sentence of our own", () => {
    for (const d of ANKIWEB_DECKS) {
      expect(IMPORT_LANGS as readonly string[]).toContain(d.lang);
      expect(d.title.trim()).not.toBe("");
      expect(d.level.trim()).not.toBe("");
      expect(d.description.length).toBeLessThan(200);
      // One sentence: a single full stop, at the end.
      expect(d.description).toMatch(/^[^.]+(\.\d[^.]*)*\.$/);
    }
  });

  test("licence is personal, open, or stated with where it is stated", () => {
    for (const d of ANKIWEB_DECKS) {
      if (d.licence === "personal") continue;
      expect(d.licenceNote ?? "").not.toBe("");
    }
  });

  test("covers English, Japanese JLPT N5–N1 and Chinese HSK", () => {
    const levels = ANKIWEB_DECKS.map((d) => `${d.lang} ${d.level}`).join("\n");
    for (const n of ["N5", "N4", "N3", "N2", "N1"]) expect(levels).toContain(`ja JLPT ${n}`);
    expect(levels).toMatch(/^zh HSK/m);
    expect(levels).toMatch(/^en /m);
  });
});

describe("links", () => {
  test("info page links match what the import API accepts", () => {
    for (const d of ANKIWEB_DECKS) expect(ankiWebInfoUrl(d.id)).toMatch(ANKIWEB_INFO_RE);
  });

  test("AnkiWeb search: one constant, query encoded", () => {
    expect(ANKIWEB_SEARCH_URL).toBe("https://ankiweb.net/shared/decks?search=");
    expect(ankiWebSearchUrl(" HSK 4 & more ")).toBe(
      "https://ankiweb.net/shared/decks?search=HSK%204%20%26%20more",
    );
    expect(ankiWebSearchUrl("")).toBe(ANKIWEB_SEARCH_URL);
  });

  test("a pasted deck page link becomes its canonical URL; anything else is refused", () => {
    expect(parseAnkiWebUrl("https://ankiweb.net/shared/info/135014526")).toBe(
      "https://ankiweb.net/shared/info/135014526",
    );
    expect(parseAnkiWebUrl(" ankiweb.net/shared/info/42?x=1 ")).toBe(
      "https://ankiweb.net/shared/info/42",
    );
    expect(parseAnkiWebUrl("https://ankiweb.net/shared/decks?search=x")).toBeNull();
    expect(parseAnkiWebUrl("https://evil.example/ankiweb.net/shared/info/1")).toBeNull();
    expect(parseAnkiWebUrl("")).toBeNull();
  });
});

describe("searchDecks (our list only)", () => {
  test("empty query: everything", () => {
    expect(searchDecks("")).toHaveLength(ANKIWEB_DECKS.length);
  });

  test("every word must match; case and accents ignored", () => {
    expect(searchDecks("jlpt n3").map((d) => d.id)).toEqual(["1934609314"]);
    expect(searchDecks("HSK").every((d) => d.lang === "zh")).toBe(true);
    expect(
      searchDecks("FRANCAIS frequency", undefined, (c) => (c === "fr" ? ["français"] : [])),
    ).toHaveLength(1);
  });

  test("matches language names passed in", () => {
    const names = (c: string) => (c === "de" ? ["German", "Deutsch"] : []);
    expect(searchDecks("deutsch", undefined, names).map((d) => d.lang)).toEqual(["de"]);
  });

  test("nothing for an unknown word", () => {
    expect(searchDecks("klingon")).toEqual([]);
  });
});

describe("matchDeck", () => {
  test("an .apkg deck named like a curated one", () => {
    expect(matchDeck("Open Anki JLPT N2 Vocab")?.id).toBe("1850740099");
    expect(matchDeck("Kaishi 1.5k::Vocabulary")?.id).toBe("1196762551");
  });

  test("no match for an unrelated or too short name", () => {
    expect(matchDeck("My deck")).toBeUndefined();
    expect(matchDeck("HSK")).toBeUndefined();
    expect(matchDeck("")).toBeUndefined();
  });
});
