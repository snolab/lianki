import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  cleanByShape,
  createUiStore,
  resetUiStores,
  safeStorage,
  uiKey,
  useUi,
} from "@lianki/ui-state";
import {
  anchorTop,
  cleanWordsUi,
  migrateCollapsed,
  setAnchor,
  toggleCollapsed,
  topIndex,
  wordsUiStore,
} from "@/app/(app)/words/ui-store";

/** A Storage stand-in. */
function fakeStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

const g = globalThis as unknown as Record<string, unknown>;
let session: ReturnType<typeof fakeStorage>;
let local: ReturnType<typeof fakeStorage>;
const listeners: ((e: { key: string }) => void)[] = [];

/** Pretend to be a browser tab: window, sessionStorage, localStorage. */
function browser(seedSession: Record<string, string> = {}, seedLocal: Record<string, string> = {}) {
  session = fakeStorage(seedSession);
  local = fakeStorage(seedLocal);
  g.window = {
    sessionStorage: session,
    localStorage: local,
    addEventListener: (_: string, l: (e: { key: string }) => void) => listeners.push(l),
  };
}

beforeEach(() => resetUiStores());
afterEach(() => {
  delete g.window;
  listeners.length = 0;
  resetUiStores();
});

describe("createUiStore", () => {
  it("keys: lk:ui:<name> per tab, lk:pref:<name> per device", () => {
    expect(uiKey("words", "session")).toBe("lk:ui:words");
    expect(uiKey("swipe-feel", "local")).toBe("lk:pref:swipe-feel");
  });

  it("persists to sessionStorage and reads it back after a refresh", () => {
    browser();
    const s = createUiStore("t", 1, { open: false, n: 0 }, { storage: "session" });
    s.setState({ open: true, n: 3 });
    expect(JSON.parse(session.m.get("lk:ui:t")!)).toEqual({
      state: { open: true, n: 3 },
      version: 1,
    });
    // A refresh: a new page, the same tab's storage.
    const kept = session.m.get("lk:ui:t")!;
    resetUiStores();
    browser({ "lk:ui:t": kept });
    expect(createUiStore("t", 1, { open: false, n: 0 }, { storage: "session" }).getState()).toEqual(
      {
        open: true,
        n: 3,
      },
    );
  });

  it("is one instance per page: a hot-swapped island gets the same store", () => {
    browser();
    const a = createUiStore("t", 1, { open: false }, { storage: "session" });
    a.setState({ open: true });
    const b = createUiStore("t", 1, { open: false }, { storage: "session" });
    expect(b).toBe(a);
    expect(b.getState().open).toBe(true);
    expect(() => createUiStore("t", 2, { open: false }, { storage: "session" })).toThrow(
      /page has v1, this code wants v2/,
    );
  });

  it("cleans what it reads; drops an old version without migrate, migrates with one", () => {
    browser({
      "lk:ui:bad": JSON.stringify({ state: { open: "yes", n: 2, extra: 1 }, version: 1 }),
      "lk:ui:old": JSON.stringify({ state: { o: 1 }, version: 1 }),
      "lk:ui:mig": JSON.stringify({ state: { o: 1 }, version: 1 }),
      "lk:ui:junk": "{not json",
    });
    expect(
      createUiStore("bad", 1, { open: false, n: 0 }, { storage: "session" }).getState(),
    ).toEqual({ open: false, n: 2 });
    expect(createUiStore("old", 2, { open: false }, { storage: "session" }).getState()).toEqual({
      open: false,
    });
    const mig = createUiStore(
      "mig",
      2,
      { open: false },
      {
        storage: "session",
        migrate: (s, from) => ({ open: from === 1 && (s as { o: number }).o === 1 }),
      },
    );
    expect(mig.getState()).toEqual({ open: true });
    expect(createUiStore("junk", 1, { open: false }, { storage: "session" }).getState()).toEqual({
      open: false,
    });
  });

  it("stores only `keys` when given", () => {
    browser();
    const s = createUiStore("k", 1, { a: 1, b: 2 }, { storage: "session", keys: ["a"] });
    s.setState({ a: 5, b: 6 });
    expect(JSON.parse(session.m.get("lk:ui:k")!).state).toEqual({ a: 5 });
  });

  it("local stores follow other tabs through the storage event", async () => {
    browser();
    const s = createUiStore("p", 1, { theme: "light" }, { storage: "local" });
    local.m.set("lk:pref:p", JSON.stringify({ state: { theme: "dark" }, version: 1 }));
    for (const l of listeners) l({ key: "lk:pref:p" });
    await Promise.resolve();
    expect(s.getState().theme).toBe("dark");
  });

  it("never throws on storage, and works with no window at all (memory)", () => {
    const bad = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    g.window = { sessionStorage: bad, localStorage: bad, addEventListener: () => {} };
    const st = safeStorage("session");
    st.setItem("x", "1");
    expect(st.getItem("x")).toBe("1");
    st.removeItem("x");
    expect(st.getItem("x")).toBeNull();
    delete g.window;
    const s = createUiStore("srv", 1, { open: false }, { storage: "session" });
    s.setState({ open: true });
    expect(s.getState().open).toBe(true);
    // No registry on the server: each request's module gets its own.
    expect(createUiStore("srv", 1, { open: false }, { storage: "session" })).not.toBe(s);
  });

  it("useUi renders the initial state on the server, whatever is stored", () => {
    browser({ "lk:ui:r": JSON.stringify({ state: { open: true }, version: 1 }) });
    const s = createUiStore("r", 1, { open: false }, { storage: "session" });
    expect(s.getState().open).toBe(true);
    const C = () => createElement("i", null, String(useUi(s, (x) => x.open)));
    expect(renderToString(createElement(C))).toBe("<i>false</i>");
  });

  it("cleanByShape keeps only same-typed keys of the initial state", () => {
    const init = { a: 1, b: "x", c: null as string | null, d: [] as number[], e: {} };
    expect(cleanByShape(init, { a: "1", b: "y", c: "z", d: [1], e: [], f: 1 })).toEqual({
      b: "y",
      c: "z",
      d: [1],
    });
    expect(cleanByShape(init, null)).toEqual({});
  });
});

describe("/words UI store", () => {
  it("one store per page, and it survives a refresh", () => {
    browser();
    const w = wordsUiStore("/words");
    expect(wordsUiStore("/words")).toBe(w);
    expect(wordsUiStore("/alphabets")).not.toBe(w);
    w.setState({ listId: "L1", settingsOpen: true });
    setAnchor(w, "L1", "L1\u0000chat");
    const kept = session.m.get("lk:ui:words")!;
    resetUiStores();
    browser({ "lk:ui:words": kept });
    expect(wordsUiStore("/words").getState()).toEqual({
      listId: "L1",
      settingsOpen: true,
      helpOpen: false,
      anchors: { L1: "L1\u0000chat" },
      collapsed: [],
    });
  });

  it("anchors: set, clear, capped at the 20 latest lists", () => {
    browser();
    const w = wordsUiStore("/words");
    for (let i = 0; i < 25; i++) setAnchor(w, `L${i}`, `k${i}`);
    expect(Object.keys(w.getState().anchors)).toHaveLength(20);
    expect(w.getState().anchors.L0).toBeUndefined();
    expect(w.getState().anchors.L24).toBe("k24");
    const before = w.getState();
    setAnchor(w, "L24", "k24");
    expect(w.getState()).toBe(before);
    setAnchor(w, "L24", null);
    expect(w.getState().anchors.L24).toBeUndefined();
    setAnchor(w, "nope", null);
  });

  it("cleans what it reads", () => {
    expect(cleanWordsUi(null)).toEqual({});
    expect(
      cleanWordsUi({ listId: 3, settingsOpen: "y", helpOpen: true, anchors: { a: "k", b: 2 } }),
    ).toEqual({ helpOpen: true, anchors: { a: "k" } });
    expect(cleanWordsUi({ listId: null, anchors: [] })).toEqual({ listId: null });
  });

  it("folded groups: per tab, toggled, cleaned", () => {
    browser();
    const w = wordsUiStore("/words");
    toggleCollapsed(w, "ja");
    toggleCollapsed(w, "fr");
    expect(w.getState().collapsed).toEqual(["ja", "fr"]);
    toggleCollapsed(w, "ja");
    expect(w.getState().collapsed).toEqual(["fr"]);
    expect(cleanWordsUi({ collapsed: ["a", 3, "b"] })).toEqual({ collapsed: ["a", "b"] });
    expect(cleanWordsUi({ collapsed: "a" })).toEqual({});
  });

  it("folded groups: the old per-device key is carried over once", () => {
    browser();
    const w = wordsUiStore("/words");
    const local = fakeStorage({ "lk:words-collapsed:/words": '["g1","g2"]' });
    migrateCollapsed(w, "/words", local as unknown as Storage);
    expect(w.getState().collapsed).toEqual(["g1", "g2"]);
    expect(local.m.has("lk:words-collapsed:/words")).toBe(false);
    // A newer choice in this tab is never overwritten.
    toggleCollapsed(w, "g1");
    local.m.set("lk:words-collapsed:/words", '["x"]');
    migrateCollapsed(w, "/words", local as unknown as Storage);
    expect(w.getState().collapsed).toEqual(["g2"]);
    migrateCollapsed(w, "/words", fakeStorage({ "lk:words-collapsed:/words": "{bad" }) as never);
    expect(w.getState().collapsed).toEqual(["g2"]);
  });

  it("anchor ↔ scrollTop: the anchored word lands just under the toolbar", () => {
    const o = { pad: 300, rowH: 44, barTop: 100 };
    expect(anchorTop(-1, o)).toBeNull();
    expect(anchorTop(0, o)).toBe(200);
    expect(anchorTop(5, o)).toBe(420);
    expect(anchorTop(5, { ...o, max: 300 })).toBe(300);
    expect(topIndex(420, o)).toBe(5);
    expect(topIndex(0, o)).toBe(0);
  });
});
