import { describe, expect, test } from "bun:test";
import { buildAddTree, branchKeys, leavesOf, type AddNode } from "@/lib/words/add-tree";
import {
  EXTERNAL_SEARCHES,
  SEARCH_ENGINES,
  searchLinks,
  searchUrl,
  type ExternalSearch,
} from "@/lib/words/external-search";
import catalog from "@/public/words/index.json";

// Exams Lianki cannot ship get search links only (docs/word-deck-sources.md,
// "Search links for what is not shipped"): never a link to a deck or a file.

const ENDPOINTS: Record<string, RegExp> = {
  ankiweb: /^https:\/\/ankiweb\.net\/shared\/decks\?search=[^&#]+$/,
  github: /^https:\/\/github\.com\/search\?q=[^&#]+&type=repositories$/,
  google: /^https:\/\/www\.google\.com\/search\?q=[^&#]+$/,
};

describe("external search data", () => {
  test("unique ids, a language the catalog has, an exam name", () => {
    const ids = EXTERNAL_SEARCHES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const langs = new Set(catalog.lists.map((l) => l.lang));
    for (const s of EXTERNAL_SEARCHES) {
      expect(s.id).toMatch(/^[a-z]{2,3}-[a-z0-9-]+$/);
      expect(s.id.startsWith(`${s.lang}-`)).toBe(true);
      expect(langs.has(s.lang)).toBe(true);
      expect(s.exam.trim()).toBe(s.exam);
      expect(s.exam.length).toBeGreaterThan(0);
    }
  });

  test("every entry builds a valid search URL on each of the three engines only", () => {
    for (const s of EXTERNAL_SEARCHES) {
      expect(Object.keys(s.queries).sort()).toEqual([...SEARCH_ENGINES].sort());
      const links = searchLinks(s);
      expect(links.map((l) => l.engine)).toEqual([...SEARCH_ENGINES]);
      for (const l of links) {
        expect(l.url).toMatch(ENDPOINTS[l.engine]);
        const u = new URL(l.url);
        const q = u.searchParams.get(l.engine === "ankiweb" ? "search" : "q");
        expect(q).toBe(s.queries[l.engine].trim());
      }
    }
  });

  test("no query is or holds a direct resource link", () => {
    for (const s of EXTERNAL_SEARCHES)
      for (const q of Object.values(s.queries)) {
        expect(q.trim().length).toBeGreaterThan(0);
        expect(q).not.toMatch(/https?:|www\.|:\/\/|\/|\.(pdf|apkg|csv|txt|json|xlsx?|zip)\b/i);
        expect(q).not.toMatch(/\b[a-z0-9-]+\.(com|net|org|io|de|fr|uk)\b/i);
      }
    // Nothing else in the file is a URL either.
    const raw = JSON.stringify(EXTERNAL_SEARCHES);
    expect(raw).not.toMatch(/https?:\/\//);
  });

  test("covers every exam docs/word-deck-sources.md lists as not shipped", () => {
    const exams = new Set(EXTERNAL_SEARCHES.map((s) => s.exam));
    for (const name of [
      "IELTS",
      "TOEFL",
      "GRE",
      "SAT",
      "Oxford 3000",
      "Oxford 5000",
      "DELF",
      "DALF",
      "TCF",
      "TEF",
      "Goethe-Zertifikat",
      "DELE",
      "CILS",
      "CELI",
      "CAPLE",
      "CELPE-Bras",
      "TORFL (ТРКИ)",
      "TOPIK",
    ])
      expect(exams.has(name)).toBe(true);
  });

  test("queries are encoded", () => {
    expect(searchUrl("google", " DELF B2 vocabulaire ")).toBe(
      "https://www.google.com/search?q=DELF%20B2%20vocabulaire",
    );
    expect(searchUrl("github", "a&b")).toBe("https://github.com/search?q=a%26b&type=repositories");
  });
});

describe("external nodes in the add tree", () => {
  const ext: ExternalSearch[] = [
    { id: "fr-delf-b2", lang: "fr", exam: "DELF", level: "B2", queries: q("DELF B2") },
    { id: "fr-delf-b1", lang: "fr", exam: "DELF", level: "B1", queries: q("DELF B1") },
    { id: "fr-tcf", lang: "fr", exam: "TCF", queries: q("TCF") },
    { id: "it-cils", lang: "it", exam: "CILS", queries: q("CILS") },
  ];
  const tree = buildAddTree(
    [
      { id: "fr-freq-1", lang: "fr" },
      { id: "fr-freq-2", lang: "fr" },
    ],
    [],
    ext,
  );
  const fr = tree[0] as Extract<AddNode, { kind: "lang" }>;

  test("under Exam word lists: levels grouped by exam, a lone entry right under it", () => {
    expect(tree.map((n) => n.key)).toEqual(["lang:fr", "lang:it"]);
    expect(fr.children.map((c) => c.key)).toEqual(["fr/freq", "fr/exam"]);
    const exam = fr.children[1] as Extract<AddNode, { kind: "family" }>;
    expect(exam.children.map((c) => c.key)).toEqual(["fr/exam/DELF", "ext:fr-tcf"]);
    const delf = exam.children[0] as Extract<AddNode, { kind: "exam" }>;
    expect(delf.children.map((c) => c.key)).toEqual(["ext:fr-delf-b2", "ext:fr-delf-b1"]);
  });

  test("nothing to tick and folded by default", () => {
    expect(leavesOf(fr).map((m) => m.id)).toEqual(["fr-freq-1", "fr-freq-2"]);
    expect(leavesOf(tree[1])).toEqual([]);
    expect(branchKeys(fr).some((k) => k.startsWith("ext:"))).toBe(false);
  });
});

function q(s: string) {
  return { ankiweb: s, github: `${s} vocabulary`, google: `${s} vocabulary list` };
}
