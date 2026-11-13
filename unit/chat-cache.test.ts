import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { ChatMessage } from "@/lib/dev-eval";
import {
  CHAT_CACHE_KEY,
  CHAT_CACHE_MAX_BYTES,
  cacheLine,
  clearChatCache,
  readChatCache,
  reconcileHistory,
  writeChatCache,
} from "@/lib/chat-cache";
import {
  PREFETCH_FALLBACK_MS,
  chatPrefetchWanted,
  prefetchWhenIdle,
  resetChatPrefetch,
} from "@/lib/chat-prefetch";
import { signOut } from "@/lib/sign-out";
import { CONFIG } from "@/lib/config";

function memStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const line = (id: string, text = `t-${id}`, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: "agent",
  label: "",
  text,
  at: Number(id.replace(/\D/g, "")) || 1,
  ...extra,
});

describe("chat cache: write and read", () => {
  it("reads back what was written for the same account", () => {
    const s = memStore();
    writeChatCache("acct-a", [line("1"), line("2")], 40, s);
    expect(readChatCache("acct-a", s).map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("keeps only the newest N lines", () => {
    const s = memStore();
    const lines = Array.from({ length: 50 }, (_, i) => line(String(i + 1)));
    writeChatCache("acct-a", lines, 40, s);
    const got = readChatCache("acct-a", s);
    expect(got).toHaveLength(40);
    expect(got[0].id).toBe("11");
    expect(got.at(-1)?.id).toBe("50");
  });

  it("N = 0 keeps nothing (and drops what was there)", () => {
    const s = memStore();
    writeChatCache("acct-a", [line("1")], 40, s);
    writeChatCache("acct-a", [line("1")], 0, s);
    expect(s.m.has(CHAT_CACHE_KEY)).toBe(false);
  });

  it("stays under the byte cap by dropping the oldest lines", () => {
    const s = memStore();
    const big = "x".repeat(20_000);
    writeChatCache(
      "acct-a",
      Array.from({ length: 30 }, (_, i) => line(String(i + 1), big)),
      40,
      s,
    );
    expect(s.m.get(CHAT_CACHE_KEY)!.length).toBeLessThanOrEqual(CHAT_CACHE_MAX_BYTES);
    expect(readChatCache("acct-a", s).at(-1)?.id).toBe("30");
  });

  it("a corrupt entry reads as nothing and is dropped", () => {
    const s = memStore();
    s.setItem(CHAT_CACHE_KEY, "{not json");
    expect(readChatCache("acct-a", s)).toEqual([]);
    expect(s.m.has(CHAT_CACHE_KEY)).toBe(false);
  });

  it("no storage (private mode): nothing, no throw", () => {
    expect(readChatCache("acct-a", null)).toEqual([]);
    expect(() => writeChatCache("acct-a", [line("1")], 40, null)).not.toThrow();
  });
});

describe("chat cache: account isolation", () => {
  it("never returns another account's lines, and drops them", () => {
    const s = memStore();
    writeChatCache("acct-a", [line("1", "secret of a")], 40, s);
    expect(readChatCache("acct-b", s)).toEqual([]);
    expect(s.m.has(CHAT_CACHE_KEY)).toBe(false);
    // Even back as A, they are gone: B's page dropped them.
    expect(readChatCache("acct-a", s)).toEqual([]);
  });

  it("a signed-out page (no account) reads nothing and drops the entry", () => {
    const s = memStore();
    writeChatCache("acct-a", [line("1")], 40, s);
    expect(readChatCache(null, s)).toEqual([]);
    expect(readChatCache(undefined, s)).toEqual([]);
    expect(s.m.has(CHAT_CACHE_KEY)).toBe(false);
  });

  it("no account writes nothing", () => {
    const s = memStore();
    writeChatCache(null, [line("1")], 40, s);
    expect(s.m.has(CHAT_CACHE_KEY)).toBe(false);
  });

  it("one entry per device: writing for B replaces A's", () => {
    const s = memStore();
    writeChatCache("acct-a", [line("1")], 40, s);
    writeChatCache("acct-b", [line("2")], 40, s);
    expect(readChatCache("acct-a", s)).toEqual([]);
    writeChatCache("acct-b", [line("2")], 40, s);
    expect(readChatCache("acct-b", s).map((m) => m.id)).toEqual(["2"]);
  });
});

describe("chat cache: sign-out", () => {
  it("clearChatCache drops it", () => {
    const s = memStore();
    writeChatCache("acct-a", [line("1")], 40, s);
    clearChatCache(s);
    expect(s.m.size).toBe(0);
  });

  it("signOut forgets the chat's lines, offline too", async () => {
    let forgot = 0;
    await signOut("/", {
      fetch: async () => {
        throw new TypeError("offline");
      },
      replace: () => {},
      forgetChat: () => void forgot++,
    });
    expect(forgot).toBe(1);
  });

  it("the browser's signOut wires forgetChat to clearChatCache", () => {
    const src = readFileSync("lib/sign-out.ts", "utf8");
    expect(src).toContain("forgetChat: () => clearChatCache()");
  });
});

describe("chat cache: never kept (docs/chat-history.md)", () => {
  it("drops context, scene, raw STT, parts, timings, speaker tags, labels, avatars, emails, attachments", () => {
    const full = {
      ...line("1", "hello"),
      from: "owner",
      label: "/words pwa Mozilla/5.0 iPhone",
      email: "a@example.test",
      sender: { id: "h1", name: "Taku", avatars: ["https://example.test/a.png"] },
      context: { text: "page selection", url: "/reader/x" },
      scene: { path: "/vibe", title: "private", text: "screen text" },
      raw: "helo",
      parts: [{ id: "p", text: "helo", at: 1 }],
      timing: { start: 1 },
      stt: { route: "cloud" },
      speaker: { ok: true },
      attachments: [{ id: "att-1", name: "x.png" }],
      premerge: { text: "before" },
      wake: "active",
      wakeReason: "word",
      mergeable: true,
      answer: { choices: { q: ["yes"] }, source: "tap", thread: "owner", label: "/x UA", at: 2 },
      lane: "codex",
      edited: { at: 2, by: "main", count: 1 },
    } as unknown as ChatMessage;
    const kept = cacheLine(full) as Record<string, unknown>;
    for (const k of [
      "email",
      "context",
      "scene",
      "raw",
      "parts",
      "timing",
      "stt",
      "speaker",
      "attachments",
      "premerge",
      "wake",
      "wakeReason",
      "mergeable",
    ])
      expect(kept[k]).toBeUndefined();
    expect(kept.label).toBe("");
    expect(kept.sender).toEqual({ id: "h1", name: "Taku" });
    expect((kept.answer as { label: string }).label).toBe("");
    expect(kept.text).toBe("hello");
    expect(kept.lane).toBe("codex");
    expect(kept.edited).toEqual({ at: 2, by: "main", count: 1 });
  });

  it("what is stored on disk carries none of it", () => {
    const s = memStore();
    writeChatCache(
      "acct-a",
      [{ ...line("1"), context: { text: "SELECTED" }, raw: "RAWSTT" } as unknown as ChatMessage],
      40,
      s,
    );
    const raw = s.m.get(CHAT_CACHE_KEY)!;
    expect(raw).not.toContain("SELECTED");
    expect(raw).not.toContain("RAWSTT");
  });
});

describe("reconcileHistory: the hub wins", () => {
  it("replaces the cached lines with the hub's", () => {
    const cached = [line("1", "old"), line("2", "deleted since")];
    const hub = [line("1", "polished"), line("3")];
    expect(reconcileHistory(cached, hub)).toEqual([line("1", "polished"), line("3")]);
  });

  it("dedupes by id: one line per id, the hub's last copy, in its first place", () => {
    const hub = [line("1", "a"), line("2"), line("1", "a2")];
    const got = reconcileHistory([], hub);
    expect(got.map((m) => m.id)).toEqual(["1", "2"]);
    expect(got[0].text).toBe("a2");
  });

  it("an empty hub history empties the chat (nothing cached survives)", () => {
    expect(reconcileHistory([line("1")], [])).toEqual([]);
  });
});

describe("chat prefetch gate", () => {
  beforeEach(() => resetChatPrefetch());

  it("never for a guest, whatever else is on", () => {
    expect(chatPrefetchWanted({ account: null, partnerOpen: true, debug: true })).toBe(false);
    expect(chatPrefetchWanted({ account: undefined, partnerOpen: true, debug: false })).toBe(false);
    expect(chatPrefetchWanted({ account: "", partnerOpen: false, debug: true })).toBe(false);
  });

  it("a signed-in viewer only when the chat is wanted (partner open, or debug mode)", () => {
    expect(chatPrefetchWanted({ account: "a", partnerOpen: true, debug: false })).toBe(true);
    expect(chatPrefetchWanted({ account: "a", partnerOpen: false, debug: true })).toBe(true);
    expect(chatPrefetchWanted({ account: "a", partnerOpen: false, debug: false })).toBe(false);
  });

  it("loads once, in idle time", async () => {
    let idle: (() => void) | null = null;
    let loads = 0;
    const win = {
      requestIdleCallback: (cb: () => void) => {
        idle = cb;
        return 1;
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
    };
    prefetchWhenIdle(async () => void loads++, win);
    expect(loads).toBe(0);
    (idle as unknown as () => void)();
    prefetchWhenIdle(async () => void loads++, win);
    (idle as unknown as () => void)();
    expect(loads).toBe(1);
  });

  it("falls back to a short timeout without requestIdleCallback, and cancels on unmount", () => {
    const timers: { cb: () => void; ms: number }[] = [];
    let cleared = 0;
    let loads = 0;
    const cancel = prefetchWhenIdle(async () => void loads++, {
      setTimeout: (cb: () => void, ms: number) => timers.push({ cb, ms }),
      clearTimeout: () => void cleared++,
    });
    expect(timers[0].ms).toBe(PREFETCH_FALLBACK_MS);
    cancel();
    expect(cleared).toBe(1);
    expect(loads).toBe(0);
  });

  it("DebugEval prefetches the very module React.lazy loads, behind the gate", () => {
    const src = readFileSync("app/components/DebugEval.tsx", "utf8");
    expect(src).toContain('const loadChatHost = () => import("@lianki/debug-chat/DebugChatHost")');
    expect(src).toContain("lazy(() => loadChatHost()");
    expect(src).toMatch(
      /if \(!chatPrefetchWanted\(\{ account,[^;]{0,120}\)\) return;\s*return prefetchWhenIdle\(loadChatHost/,
    );
  });
});

describe("config chat.cacheLines", () => {
  it("defaults to 40, 0 allowed (off)", () => {
    expect(CONFIG["chat.cacheLines"].default).toBe(40);
    expect(CONFIG["chat.cacheLines"].schema.safeParse(0).success).toBe(true);
  });
});
