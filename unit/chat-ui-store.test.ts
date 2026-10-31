import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetUiStores, uiKey } from "@lianki/ui-state";
import { keepTree, navIndexOf, restoreTree } from "@lianki/debug-chat/tree-keep";
import { indexTree, restoreNav } from "@lianki/debug-chat/tree-nav";
import {
  CHAT_UI_INITIAL,
  CHAT_UI_NAME,
  CHAT_UI_VERSION,
  type ChatUi,
  chatUi,
  migrateChatUi,
} from "@lianki/debug-chat/ui-store";

/** A page for the factory: a window with a Map-backed sessionStorage. */
function fakePage() {
  const data = new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
  (globalThis as { window?: unknown }).window = {
    sessionStorage,
    addEventListener() {},
  };
  return data;
}

describe("chatUi (on @lianki/ui-state)", () => {
  let data: Map<string, string>;
  beforeEach(() => {
    data = fakePage();
    resetUiStores();
  });
  afterEach(() => {
    resetUiStores();
    delete (globalThis as { window?: unknown }).window;
  });

  it("is kept under lk:ui:chat in sessionStorage, and comes back", () => {
    const key = uiKey(CHAT_UI_NAME, "session");
    expect(key).toBe("lk:ui:chat");
    chatUi().setState({ draft: "kept line", caret: 4, pureDictation: "kept line", panel: "tree" });
    expect(JSON.parse(data.get(key)!)).toMatchObject({
      version: CHAT_UI_VERSION,
      state: { draft: "kept line", caret: 4, pureDictation: "kept line", panel: "tree" },
    });
    // A new page (refresh): a fresh store reads it back.
    resetUiStores();
    expect(chatUi().getState()).toMatchObject({ draft: "kept line", caret: 4, panel: "tree" });
  });

  it("one store per page: a re-imported widget gets the same one", () => {
    expect(chatUi()).toBe(chatUi());
  });

  it("a damaged entry is cleaned on the way in", () => {
    data.set(
      "lk:ui:chat",
      JSON.stringify({ state: { draft: 7, caret: 99, panel: "menu" }, version: CHAT_UI_VERSION }),
    );
    expect(chatUi().getState()).toMatchObject({ draft: "", caret: 0, panel: "none", tree: null });
  });

  it("an older version goes through migrate", () => {
    data.set("lk:ui:chat", JSON.stringify({ state: { draft: "old", caret: 1 }, version: 0 }));
    expect(chatUi().getState()).toMatchObject({ draft: "old", caret: 1 });
  });
});

describe("migrateChatUi", () => {
  it("keeps a valid state as it is", () => {
    const s: ChatUi = {
      draft: "hello there",
      caret: 5,
      pureDictation: "hello there",
      panel: "tree",
      tree: {
        focus: ["Plan", "Lane B"],
        expanded: [
          [["Plan"], 1],
          [["Plan", "Lane B"], 2],
        ],
        scroll: 120,
      },
    };
    expect(migrateChatUi(s, CHAT_UI_VERSION)).toEqual(s);
  });

  it("anything damaged or foreign falls back to the default", () => {
    expect(migrateChatUi(null, 0)).toEqual(CHAT_UI_INITIAL);
    expect(migrateChatUi("x", 0)).toEqual(CHAT_UI_INITIAL);
    expect(migrateChatUi({ draft: 42, panel: "menu", caret: -1 }, 0)).toEqual(CHAT_UI_INITIAL);
    expect(migrateChatUi({ draft: "x".repeat(20_001) }, 0).draft).toBe("");
  });

  it("clamps the caret into the draft, and keeps dictation only while it is the draft", () => {
    expect(migrateChatUi({ draft: "abc", caret: 99 }, 1).caret).toBe(3);
    expect(migrateChatUi({ draft: "abc", caret: 1.5 }, 1).caret).toBeNull();
    // Typed into after dictation: no longer a voice line.
    expect(migrateChatUi({ draft: "abc!", pureDictation: "abc" }, 1).pureDictation).toBeNull();
    expect(migrateChatUi({ draft: "", pureDictation: "" }, 1).pureDictation).toBeNull();
  });

  it("keeps only well-formed tree paths and depths (capped at 3)", () => {
    const m = migrateChatUi(
      {
        tree: {
          focus: "Plan",
          expanded: [[["Plan"], 9], [["x"], -1], [[1], 1], "junk", [["y"], 1.5]],
          scroll: -4,
        },
      },
      1,
    );
    expect(m.tree).toEqual({ focus: null, expanded: [[["Plan"], 3]], scroll: 0 });
    expect(migrateChatUi({ tree: "x" }, 1).tree).toBeNull();
    expect(migrateChatUi({ tree: { focus: [] } }, 1).tree?.focus).toBeNull();
  });
});

describe("restoreNav", () => {
  type T = { id: string; kids?: T[] };
  const t = (id: string, ...kids: T[]): T => ({ id, kids });
  const ix = indexTree(
    [t("0", t("0.0", t("0.0.0")), t("0.1")), t("1")],
    (n) => n.kids ?? [],
    (n) => n.id,
  );
  it("brings the kept focus and depths back on the same tree", () => {
    expect(restoreNav(ix, { focusId: "0.0", expanded: { "0": 1, "0.0": 1 } })).toEqual({
      focusId: "0.0",
      expanded: { "0": 1, "0.0": 1 },
      detent: 0,
    });
  });
  it("drops what the tree no longer has, caps depths, keeps one branch", () => {
    expect(restoreNav(ix, { focusId: "0", expanded: { "0": 3, "9": 1, "1": 1 } })).toEqual({
      focusId: "0",
      expanded: { "0": 2 },
      detent: 0,
    });
  });
  it("a focus that is gone: null (start over)", () => {
    expect(restoreNav(ix, { focusId: "7", expanded: {} })).toBeNull();
    expect(restoreNav(ix, null)).toBeNull();
    expect(restoreNav(ix, { focusId: null, expanded: {} })).toBeNull();
  });
});

describe("keepTree / restoreTree (by title paths)", () => {
  const tree = (titles: [string, string[]][]) =>
    navIndexOf({
      title: "",
      children: titles.map(([title, kids]) => ({
        title,
        children: kids.map((k) => ({ title: k, children: [] })),
      })),
    } as unknown as Parameters<typeof navIndexOf>[0]);

  const before = tree([
    ["Plan", ["Lane A", "Lane B"]],
    ["/words", ["swipe"]],
  ]);
  const kept = keepTree(before.byId, { focusId: "0.1", expanded: { "0": 1 } }, 140.4);

  it("keeps the focus and opened nodes as titles, and the scroll", () => {
    expect(kept).toEqual({ focus: ["Plan", "Lane B"], expanded: [[["Plan"], 1]], scroll: 140 });
    expect(keepTree(before.byId, { focusId: null, expanded: {} }, -3)).toEqual({
      focus: null,
      expanded: [],
      scroll: 0,
    });
  });

  it("finds them again after a node was added above (ids moved)", () => {
    const after = tree([
      ["New first", []],
      ["Plan", ["Lane 0", "Lane A", "Lane B"]],
      ["/words", ["swipe"]],
    ]);
    expect(restoreTree(after.ix, after.byId, kept)).toEqual({
      focusId: "1.2",
      expanded: { "1": 1 },
      detent: 0,
    });
  });

  it("a node that is gone falls back to its nearest ancestor", () => {
    const after = tree([
      ["Plan", ["Lane A"]],
      ["/words", ["swipe"]],
    ]);
    expect(restoreTree(after.ix, after.byId, kept)?.focusId).toBe("0");
  });

  it("nothing left of it, or nothing kept: null (start over)", () => {
    const after = tree([["Other", []]]);
    expect(restoreTree(after.ix, after.byId, kept)).toBeNull();
    expect(restoreTree(after.ix, after.byId, null)).toBeNull();
    expect(restoreTree(after.ix, after.byId, { focus: null, expanded: [] })).toBeNull();
  });
});
