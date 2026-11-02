import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetUiStores, uiKey } from "@lianki/ui-state";
import {
  COMPACT_ASKS,
  type CompactInput,
  type FoldInput,
  compactLines,
  foldIn,
  holdAtLeast,
  isCompact,
} from "@lianki/debug-chat/compact-view";
import { CHAT_VIEW_INITIAL, chatPrefs } from "@lianki/debug-chat/ui-store";

const base: CompactInput = {
  pref: true,
  open: true,
  expanded: false,
  typing: false,
  tree: false,
  fullLog: false,
};

describe("isCompact", () => {
  it("is on only with the setting, the chat open and nothing in use", () => {
    expect(isCompact(base)).toBe(true);
    expect(isCompact({ ...base, pref: false })).toBe(false);
    expect(isCompact({ ...base, open: false })).toBe(false);
    expect(isCompact({ ...base, expanded: true })).toBe(false);
    expect(isCompact({ ...base, typing: true })).toBe(false);
    expect(isCompact({ ...base, tree: true })).toBe(false);
    expect(isCompact({ ...base, fullLog: true })).toBe(false);
  });
});

describe("foldIn", () => {
  const now = 1_000_000;
  const f: FoldInput = {
    pref: true,
    open: true,
    expanded: true,
    typing: false,
    scrolledUp: false,
    busy: false,
    holdUntil: now + 1500,
    now,
  };
  it("waits out the hold, then folds", () => {
    expect(foldIn(f)).toBe(1500);
    expect(foldIn({ ...f, holdUntil: now })).toBe("now");
    expect(foldIn({ ...f, holdUntil: now - 10 })).toBe("now");
  });
  it("never folds mid-use: typing, scrolled up, a panel or the full-screen log", () => {
    expect(foldIn({ ...f, typing: true, holdUntil: 0 })).toBeNull();
    expect(foldIn({ ...f, scrolledUp: true, holdUntil: 0 })).toBeNull();
    expect(foldIn({ ...f, busy: true, holdUntil: 0 })).toBeNull();
  });
  it("has nothing to fold when off, minimized or already compact", () => {
    expect(foldIn({ ...f, pref: false })).toBeNull();
    expect(foldIn({ ...f, open: false })).toBeNull();
    expect(foldIn({ ...f, expanded: false })).toBeNull();
  });
  it("a hold only moves later", () => {
    expect(holdAtLeast(now + 8000, now, 1500)).toBe(now + 8000);
    expect(holdAtLeast(now - 5, now, 1500)).toBe(now + 1500);
  });
});

describe("compactLines", () => {
  const now = 5_000;
  const ask = (id: string, extra: object = {}) => ({
    id,
    ask: { askId: `a-${id}`, questions: [{ id: "q", question: "Deploy?", options: [] }] },
    ...extra,
  });
  it("the last message, and no asks when none is open", () => {
    expect(compactLines([], now)).toEqual({ asks: [], last: null });
    const ms = [{ id: "1" }, { id: "2" }];
    expect(compactLines(ms, now)).toEqual({ asks: [], last: ms[1]! });
  });
  it("open ask cards stay in full; answered or expired ones do not", () => {
    const open = ask("a");
    const answered = ask("b", { answer: { choices: {}, source: "tap" } });
    const expired = ask("c", { ask: { askId: "x", questions: [], expiresAt: now - 1 } });
    const last = { id: "z" };
    const { asks } = compactLines([open, answered, expired, last], now);
    expect(asks.map((m) => m.id)).toEqual(["a"]);
  });
  it("an open ask that is the last message is the line itself, not repeated", () => {
    const a = ask("a");
    expect(compactLines([{ id: "1" }, a], now)).toEqual({ asks: [], last: a });
  });
  it("keeps the newest few open asks", () => {
    const ms = [ask("1"), ask("2"), ask("3"), { id: "z" }];
    expect(compactLines(ms, now).asks.map((m) => m.id)).toEqual(
      ["1", "2", "3"].slice(-COMPACT_ASKS),
    );
  });
});

describe("chatPrefs (per device)", () => {
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    const localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    };
    (globalThis as { window?: unknown }).window = { localStorage, addEventListener() {} };
    resetUiStores();
  });
  afterEach(() => {
    resetUiStores();
    delete (globalThis as { window?: unknown }).window;
  });
  it("is off by default, and kept in localStorage lk:pref:chat-view", () => {
    expect(CHAT_VIEW_INITIAL.compact).toBe(false);
    expect(chatPrefs().getState().compact).toBe(false);
    expect(uiKey("chat-view", "local")).toBe("lk:pref:chat-view");
    chatPrefs().setState({ compact: true });
    expect(JSON.parse(data.get("lk:pref:chat-view")!).state).toEqual({ compact: true });
    resetUiStores();
    expect(chatPrefs().getState().compact).toBe(true);
  });
  it("a damaged value falls back to off", () => {
    data.set("lk:pref:chat-view", JSON.stringify({ state: { compact: "yes" }, version: 1 }));
    expect(chatPrefs().getState().compact).toBe(false);
  });
});
