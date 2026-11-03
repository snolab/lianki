import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasLemmas, parseLemmas } from "@/lib/read/lemma";
import { segmentLine } from "@/lib/read/units";
import { foldsOf, wordLang } from "@/lib/read/words";

// Finnish (owner, 2026-11-04): frequency lists in /words, and /read's lemma
// file plus language data (lib/read/lang/fi.json), with no Finnish code.
const WORDS = join(import.meta.dir, "../public/words");

type Meta = { id: string; lang: string; order?: number; coverage?: number; count: number };
const lists = (JSON.parse(readFileSync(join(WORDS, "index.json"), "utf8")).lists as Meta[]).filter(
  (l) => l.lang === "fi",
);

describe("Finnish word lists", () => {
  it("ships 500-word frequency lists in learning order with rising coverage", () => {
    expect(lists.length).toBeGreaterThanOrEqual(6);
    lists.forEach((l, i) => {
      expect(l.id).toBe(`fi-freq-${i + 1}`);
      expect(l.order).toBe(i + 1);
      expect(l.count).toBe(500);
      if (i) expect(l.coverage!).toBeGreaterThan(lists[i - 1].coverage!);
    });
    // the 80% band is reachable; 90% is past this corpus's ceiling (SOURCES.md)
    expect(lists.at(-1)!.coverage!).toBeGreaterThanOrEqual(0.8);
  });

  it("folds inflected forms into lemmas and credits its sources", () => {
    const first = JSON.parse(readFileSync(join(WORDS, "fi-freq-1.json"), "utf8"));
    const terms = new Set(first.entries.map((e: { term: string }) => e.term));
    for (const t of ["olla", "ei", "minä", "hyvä"]) expect(terms.has(t)).toBe(true);
    // olen, on, oli are olla; en is ei
    for (const t of ["olen", "on", "oli", "en"]) expect(terms.has(t)).toBe(false);
    expect(first.source).toContain("Wiktionary");
    expect(first.license).toContain("CC BY-SA 4.0");
    expect(existsSync(join(WORDS, "credits/tatoeba-fi.tsv"))).toBe(true);
  });
});

describe("Finnish in /read (data only)", () => {
  const lem = parseLemmas(readFileSync(join(WORDS, "lemma/fi.txt"), "utf8"));

  it("has a lemma file that maps case and verb forms to headwords", () => {
    expect(hasLemmas("fi")).toBe(true);
    expect(lem.of("talossa")).toContain("talo");
    expect(lem.of("olen")).toContain("olla");
    expect(lem.of("en")).toContain("ei");
    expect(foldsOf("kirjassa", "fi", lem)).toContain("kirja");
    expect(lem.has("talo")).toBe(true);
  });

  it("guesses Finnish from its function words", () => {
    expect(wordLang(null, ["Minä olen täällä, mutta hän ei ole.", "Että niin."])).toBe("fi");
  });

  it("does not cut a sentence after a Finnish abbreviation", () => {
    const line = "Ostin hedelmiä, esim. omenoita. Sitten lähdin.";
    const cuts = segmentLine(line, "fi").map(([a, b]) => line.slice(a, b).trim());
    expect(cuts).toEqual(["Ostin hedelmiä, esim. omenoita.", "Sitten lähdin."]);
  });
});
