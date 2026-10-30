import { describe, expect, it } from "bun:test";
import {
  type PaletteItem,
  asUrl,
  badge,
  dockAbove,
  dueTotal,
  edgeSwipe,
  fill,
  firstUrl,
  keyboardUp,
  nextCompact,
  rank,
  score,
  treeItems,
} from "@/lib/nav/nav-core";

// The bottom island's pure rules (docs/bottom-nav.md).

describe("search", () => {
  const items: PaletteItem[] = [
    { id: "a", kind: "go", title: "Word lists", href: "/words", keys: "words" },
    { id: "b", kind: "go", title: "Home", href: "/home" },
    { id: "c", kind: "word", title: "café", sub: "coffee", href: "/words?list=fr" },
    { id: "d", kind: "go", title: "Import", href: "/import", keys: "apkg yaml" },
  ];

  it("scores exact > prefix > word start > substring > subsequence", () => {
    expect(score("Home", "home")).toBe(100);
    expect(score("Home page", "home")).toBe(80);
    expect(score("My lists", "lis")).toBe(60);
    expect(score("Playlists", "list")).toBe(40);
    expect(score("word list", "wdl")).toBe(10);
    expect(score("word", "xyz")).toBe(0);
    expect(score("anything", "  ")).toBe(1);
  });

  it("ranks across title, meaning and hidden keys, accents folded", () => {
    expect(rank(items, "cafe").map((i) => i.id)).toEqual(["c"]);
    expect(rank(items, "coffee")[0].id).toBe("c");
    expect(rank(items, "apkg")[0].id).toBe("d");
    expect(rank(items, "").map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(rank(items, "o", 2)).toHaveLength(2);
  });

  it("knows a URL when it sees one", () => {
    expect(asUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(asUrl("example.com/x")).toBe("https://example.com/x");
    expect(asUrl("hello world")).toBeNull();
    expect(asUrl("word")).toBeNull();
    expect(asUrl("")).toBeNull();
    expect(asUrl("https://localhost")).toBeNull();
    expect(asUrl("https://[bad")).toBeNull();
    expect(firstUrl(null, "look at https://a.example/b?c=1 now")).toBe("https://a.example/b?c=1");
    expect(firstUrl("no link", undefined)).toBeNull();
  });

  it("lists the open nodes of the state tree with their paths", () => {
    const tree = [
      {
        title: "Lane A @bar-agent",
        children: [
          { title: "Fix it", children: [] },
          { title: "Done one", done: true, children: [{ title: "Child", children: [] }] },
        ],
      },
    ];
    const out = treeItems(tree, "/dev/roadmap");
    expect(out.map((i) => [i.title, i.sub])).toEqual([
      ["Lane A", undefined],
      ["Fix it", "Lane A"],
      ["Child", "Lane A › Done one"],
    ]);
    expect(treeItems(tree, "/x", 1)).toHaveLength(1);
  });
});

describe("the island's behaviour", () => {
  it("fills {placeholders}", () => {
    expect(fill("{n} due", { n: 3 })).toBe("3 due");
    expect(fill("{a} {b}", { a: "x" })).toBe("x {b}");
  });

  it("shrinks on scrolling down, returns on scrolling up, ignores jitter", () => {
    expect(nextCompact(false, 30)).toBe(true);
    expect(nextCompact(true, -10)).toBe(false);
    expect(nextCompact(true, 2)).toBe(true);
    expect(nextCompact(false, -2)).toBe(false);
  });

  it("hides for the keyboard only while typing in a shrunk viewport", () => {
    expect(keyboardUp({ vvHeight: 400, tallest: 800, editable: true })).toBe(true);
    expect(keyboardUp({ vvHeight: 400, tallest: 800, editable: false })).toBe(false);
    expect(keyboardUp({ vvHeight: 760, tallest: 800, editable: true })).toBe(false);
  });

  it("docks above the chat bar only when they would overlap", () => {
    const island = { left: 60, right: 330, top: 760, bottom: 820 };
    expect(dockAbove(island, null, 844)).toBe(0);
    // The bar at the bottom right, under the island: dock 8px above its top.
    expect(dockAbove(island, { left: 200, right: 380, top: 790, bottom: 830 }, 844)).toBe(62);
    // Dragged to the top, or already above: nothing to do.
    expect(dockAbove(island, { left: 200, right: 380, top: 100, bottom: 140 }, 844)).toBe(0);
    expect(dockAbove(island, { left: 340, right: 380, top: 790, bottom: 830 }, 844)).toBe(0);
  });

  it("counts due reviews over lists, not groups; badges cap at 99+", () => {
    expect(dueTotal(undefined)).toBe(0);
    expect(
      dueTotal([
        { due: 3 },
        { due: 4, source: "group:words" },
        { due: -1 },
        { due: Number.NaN },
        { due: 2, source: "cat" },
      ]),
    ).toBe(5);
    expect(badge(0)).toBe("");
    expect(badge(7)).toBe("7");
    expect(badge(140)).toBe("99+");
  });

  it("opens the drawer on a swipe in from the start edge", () => {
    const o = { width: 390, rtl: false };
    expect(edgeSwipe({ x: 8, y: 300 }, { x: 70, y: 310 }, o)).toBe("open");
    expect(edgeSwipe({ x: 8, y: 300 }, { x: 20, y: 302 }, o)).toBe("wait");
    expect(edgeSwipe({ x: 100, y: 300 }, { x: 200, y: 300 }, o)).toBe("no");
    expect(edgeSwipe({ x: 8, y: 300 }, { x: 20, y: 380 }, o)).toBe("no");
    expect(edgeSwipe({ x: 382, y: 300 }, { x: 320, y: 300 }, { width: 390, rtl: true })).toBe(
      "open",
    );
  });
});
