import { describe, expect, it } from "bun:test";
import { highlight, norm } from "@/lib/nav/nav-core";
import {
  CARD_CAP,
  GROUP_ORDER,
  WORD_CAP,
  cardDocs,
  isGroupList,
  listDocs,
  listHref,
  planDocs,
  scan,
  scoreDoc,
  stampOf,
  treeDocs,
  wordDocs,
} from "@/lib/nav/search-docs";

// The nav search's own-content index (docs/bottom-nav.md, "Search"): built
// on the device from the offline copy; queries never leave it.

const alphabets = new Set(["kana"]);
const fr = { id: "L1", name: "French A1", lang: "fr", source: "fr-a1" };

describe("documents", () => {
  it("lists open on /words, alphabets on /alphabet; groups are left out", () => {
    expect(listHref(fr, alphabets)).toBe("/words?list=L1");
    expect(listHref({ id: "K", name: "Kana", source: "kana" }, alphabets)).toBe("/alphabet?list=K");
    expect(isGroupList({ id: "g", name: "g", source: "group:words" })).toBe(true);
    const [d] = listDocs([fr], alphabets, "Word lists");
    expect(d).toMatchObject({
      kind: "list",
      title: "French A1",
      sub: "Word lists",
      src: "lists",
      t: "french a1",
    });
  });

  it("words carry reading, meaning and example, and stop at the cap", () => {
    const entries = [
      {
        term: "Café",
        reading: "ka-fe",
        back: "<b>coffee</b>",
        ex: "Un café, s'il vous plaît",
        exTr: "A coffee, please",
      },
    ];
    const { docs, capped } = wordDocs(fr, entries, alphabets);
    expect(capped).toBe(false);
    expect(docs[0]).toMatchObject({
      kind: "word",
      title: "Café",
      sub: "ka-fe · coffee",
      listId: "L1",
      term: "Café",
      t: "cafe",
    });
    expect(docs[0].k).toContain("a coffee, please");
    const many = Array.from({ length: WORD_CAP + 5 }, (_, i) => ({ term: `w${i}` }));
    expect(wordDocs(fr, many, alphabets).capped).toBe(true);
    expect(wordDocs(fr, many, alphabets).docs).toHaveLength(WORD_CAP);
    expect(wordDocs(fr, many, alphabets, true).docs).toHaveLength(WORD_CAP + 5);
    expect(wordDocs(fr, [{ term: "x" }], alphabets).docs[0].sub).toBe("French A1");
  });

  it("cards, the study plan and the state tree", () => {
    expect(cardDocs([{ url: "https://a.example/x", title: "" }])[0]).toMatchObject({
      title: "https://a.example/x",
      href: "https://a.example/x",
    });
    expect(
      cardDocs(Array.from({ length: CARD_CAP + 1 }, (_, i) => ({ url: `u${i}` }))),
    ).toHaveLength(CARD_CAP);
    const plan = planDocs([
      {
        _id: "g1",
        topic: "Japanese",
        nodes: [{ title: "Kana" }, { label: "Kanji" }, { x: 1 }, null],
      },
      { id: "g2", nodes: "bad" },
    ]);
    expect(plan.map((d) => [d.title, d.sub])).toEqual([
      ["Japanese", undefined],
      ["Kana", "Japanese"],
      ["Kanji", "Japanese"],
    ]);
    const tree = treeDocs([{ title: "Lane A", children: [{ title: "Fix it", children: [] }] }]);
    expect(tree.map((d) => [d.title, d.sub, d.kind])).toEqual([
      ["Lane A", undefined, "tree"],
      ["Fix it", "Lane A", "tree"],
    ]);
    expect(GROUP_ORDER).toEqual(["list", "word", "card", "plan", "tree"]);
  });

  it("stamps change with the content only", () => {
    expect(stampOf("abc")).toBe(stampOf("abc"));
    expect(stampOf("abc")).not.toBe(stampOf("abd"));
  });
});

describe("search", () => {
  const { docs } = wordDocs(
    fr,
    [
      { term: "bonjour", back: "hello" },
      { term: "bonsoir", back: "good evening" },
      { term: "merci", back: "thank you", ex: "merci bonjour" },
    ],
    alphabets,
  );

  it("ranks titles first, then meanings and examples by substring, stable", async () => {
    const hits = await scan(docs, norm("bon"), { cancelled: () => false });
    expect(hits!.map((d) => d.title)).toEqual(["bonjour", "bonsoir", "merci"]);
    expect(
      (await scan(docs, norm("evening"), { cancelled: () => false }))!.map((d) => d.title),
    ).toEqual(["bonsoir"]);
    // A scattered subsequence in a meaning is noise.
    expect(await scan(docs, norm("hyu"), { cancelled: () => false })).toEqual([]);
    expect(scoreDoc(docs[0], "bonjour")).toBe(100);
    expect(scoreDoc(docs[2], "thank")).toBeGreaterThan(0);
  });

  it("yields between slices, and a newer keystroke cancels the round", async () => {
    let pauses = 0;
    const out = await scan(docs, "o", {
      cancelled: () => false,
      slice: 1,
      pause: async () => void pauses++,
    });
    expect(out!.length).toBeGreaterThan(0);
    expect(pauses).toBe(2);
    let n = 0;
    expect(
      await scan(docs, "o", { cancelled: () => ++n > 1, slice: 1, pause: async () => {} }),
    ).toBeNull();
    expect(await scan(docs, "o", { cancelled: () => true })).toBeNull();
    expect(await scan(docs, "o", { cancelled: () => false, limit: 1 })).toHaveLength(1);
    expect(await scan(docs.slice(0, 2), "o", { cancelled: () => false, slice: 1 })).toHaveLength(2);
  });

  it("highlights the first plain match", () => {
    expect(highlight("Bonjour", "jour")).toEqual([
      ["Bon", false],
      ["jour", true],
    ]);
    expect(highlight("Bonjour", "bon")).toEqual([
      ["Bon", true],
      ["jour", false],
    ]);
    expect(highlight("Bonjour", "x")).toEqual([["Bonjour", false]]);
    expect(highlight("Bonjour", "")).toEqual([["Bonjour", false]]);
  });
});
