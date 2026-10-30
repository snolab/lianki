import { describe, expect, it } from "bun:test";
import type { KeyStore } from "@lianki/debug-chat/storage-keys";
import { indexTree, restoreNav } from "@lianki/debug-chat/tree-nav";
import { keepTree, navIndexOf, restoreTree } from "@lianki/debug-chat/tree-keep";
import {
  CHAT_UI_INITIAL,
  CHAT_UI_NAME,
  CHAT_UI_VERSION,
  type ChatUi,
  chatUi,
  chatUiStorage,
  createUiStore,
  debouncedStorage,
  keyStorage,
  migrateChatUi,
  session,
} from "@lianki/debug-chat/ui-store";

/** A Map-backed KeyStore; `broken` makes every access throw (private mode, blocked storage). */
function fakeStore(broken = false): KeyStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const guard = () => {
    if (broken) throw new DOMException("denied", "SecurityError");
  };
  return {
    data,
    getItem: (k) => (guard(), data.get(k) ?? null),
    setItem: (k, v) => (guard(), void data.set(k, String(v))),
    removeItem: (k) => (guard(), void data.delete(k)),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

/** Timers driven by hand. */
function fakeTimers() {
  let next = 1;
  const due = new Map<number, () => void>();
  return {
    set: ((fn: () => void) => {
      due.set(next, fn);
      return next++;
    }) as unknown as typeof setTimeout,
    clear: ((id: number) => void due.delete(id)) as unknown as typeof clearTimeout,
    run: () => {
      const fns = [...due.values()];
      due.clear();
      for (const f of fns) f();
    },
    pending: () => due.size,
  };
}

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

describe("keyStorage", () => {
  it("writes under the lk:agent-… name and its legacy twin, reads the new one first", () => {
    const s = fakeStore();
    const st = keyStorage(() => s);
    st.setItem(CHAT_UI_NAME, "v1");
    expect(s.data.get("lk:agent-chat-ui")).toBe("v1");
    expect(s.data.get("lk:debug-chat-ui")).toBe("v1");
    s.data.set("lk:agent-chat-ui", "v2");
    expect(st.getItem(CHAT_UI_NAME)).toBe("v2");
    st.removeItem(CHAT_UI_NAME);
    expect(s.data.size).toBe(0);
  });

  it("never throws: blocked storage reads as empty, writes are dropped", () => {
    const st = keyStorage(() => fakeStore(true));
    expect(st.getItem(CHAT_UI_NAME)).toBeNull();
    expect(() => st.setItem(CHAT_UI_NAME, "x")).not.toThrow();
    expect(() => st.removeItem(CHAT_UI_NAME)).not.toThrow();
    expect(keyStorage(() => null).getItem("k")).toBeNull();
  });

  it("session() is null where sessionStorage is missing", () => {
    expect(session()).toBeNull(); // bun has no sessionStorage
  });
});

describe("debouncedStorage", () => {
  it("writes the latest value once, after the quiet time; reads see it at once", () => {
    const s = fakeStore();
    const t = fakeTimers();
    const st = debouncedStorage(
      keyStorage(() => s),
      300,
      t,
    );
    st.setItem("lk:debug-chat-ui", "a");
    st.setItem("lk:debug-chat-ui", "ab");
    st.setItem("lk:debug-chat-ui", "abc");
    expect(t.pending()).toBe(1);
    expect(s.data.size).toBe(0);
    expect(st.getItem("lk:debug-chat-ui")).toBe("abc");
    t.run();
    expect(s.data.get("lk:agent-chat-ui")).toBe("abc");
  });

  it("flush writes at once (the page hides), remove drops a pending write", () => {
    const s = fakeStore();
    const t = fakeTimers();
    const st = debouncedStorage(
      keyStorage(() => s),
      300,
      t,
    );
    st.setItem("k", "1");
    st.flush();
    expect(s.data.get("k")).toBe("1");
    expect(t.pending()).toBe(0);
    st.setItem("k", "2");
    st.removeItem("k");
    t.run();
    expect(s.data.has("k")).toBe(false);
  });
});

describe("chatUiStorage", () => {
  it("one per module, flushed when the page is hidden or goes away", () => {
    const st = chatUiStorage();
    expect(chatUiStorage()).toBe(st);
    st.setItem("lk:debug-test-pending", "1");
    expect(st.getItem("lk:debug-test-pending")).toBe("1"); // pending
    globalThis.dispatchEvent(new Event("pagehide"));
    // Flushed to sessionStorage, which bun has none of: the write is dropped.
    expect(st.getItem("lk:debug-test-pending")).toBeNull();
    st.setItem("lk:debug-test-pending", "2");
    globalThis.dispatchEvent(new Event("visibilitychange"));
    expect(st.getItem("lk:debug-test-pending")).toBe("2"); // no document: not "hidden"
    st.flush();
  });
});

describe("createUiStore", () => {
  it("restores what was kept, migrated, and writes changes back", () => {
    const s = fakeStore();
    s.data.set(
      "lk:agent-test-ui-a",
      JSON.stringify({ state: { draft: "kept", caret: 2, panel: "tree" }, version: 1 }),
    );
    const store = createUiStore<ChatUi>("lk:debug-test-ui-a", 1, CHAT_UI_INITIAL, {
      storage: keyStorage(() => s),
      migrate: migrateChatUi,
    });
    expect(store.getState()).toMatchObject({ draft: "kept", caret: 2, panel: "tree" });
    store.setState({ draft: "" });
    const saved = JSON.parse(s.data.get("lk:agent-test-ui-a")!);
    expect(saved).toMatchObject({ version: 1, state: { draft: "" } });
  });

  it("an older version goes through migrate", () => {
    const s = fakeStore();
    s.data.set("lk:agent-test-ui-b", JSON.stringify({ state: { draft: 7 }, version: 0 }));
    const store = createUiStore<ChatUi>("lk:debug-test-ui-b", 1, CHAT_UI_INITIAL, {
      storage: keyStorage(() => s),
      migrate: migrateChatUi,
    });
    expect(store.getState().draft).toBe("");
  });

  it("one store per name per page: a re-imported module gets the same one", () => {
    const opts = { storage: keyStorage(() => fakeStore()), migrate: migrateChatUi };
    const a = createUiStore("lk:debug-test-ui-c", 1, CHAT_UI_INITIAL, opts);
    const b = createUiStore("lk:debug-test-ui-c", 1, CHAT_UI_INITIAL, opts);
    expect(a).toBe(b);
    expect(chatUi()).toBe(chatUi());
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
