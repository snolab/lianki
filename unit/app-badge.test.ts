/**
 * The app-icon badge (docs/app-badge.md): the count, the pref, the page's
 * controller and the service worker's push side, with the Badging API mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  applyDelta,
  BADGE_DEFAULT,
  BADGE_MAX,
  BADGE_MIN_FETCH_MS,
  BADGE_MODE_EVENT,
  BADGE_MODES,
  BADGE_PREF_KEY,
  BADGE_SEEN_EVENT,
  type BadgeCounts,
  type BadgeMode,
  badgeController,
  badgeCount,
  isBadgeMode,
  noteBadgeSeen,
  parseBadgeMode,
  parseCounts,
  readBadgeMode,
  seenOn,
  setBadge,
  writeBadgeMode,
} from "@/lib/app-badge";
import {
  BADGE_CACHE_MAX,
  BADGE_CACHE_MS,
  badgeCounts,
  clearBadgeCache,
  queryBadgeCounts,
} from "@/lib/app-badge-server";
import { checkPref } from "@/lib/prefs/schema";
import { appBadgeOn } from "@/lib/app-badge-gate";
import { FLAGS } from "@/lib/flags";

describe("who gets it (lib/app-badge-gate.ts)", () => {
  test("pwa.app-badge is an owner-audience flag, default off", () => {
    expect(FLAGS["pwa.app-badge"].audience).toBe("owner");
    expect(FLAGS["pwa.app-badge"].default).toBe(false);
  });
  test("on: the owner only; off: nobody, the owner included", () => {
    expect(appBadgeOn({ "pwa.app-badge": true }, true)).toBe(true);
    expect(appBadgeOn({ "pwa.app-badge": true }, false)).toBe(false);
    expect(appBadgeOn({ "pwa.app-badge": false }, true)).toBe(false);
    expect(appBadgeOn({}, true)).toBe(false);
    expect(appBadgeOn(null, true)).toBe(false);
  });
});
import { prefBindings } from "@/lib/prefs/bindings";
import { testSchema } from "@/lib/d1/testSchema";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";

/** A Badging API that records every call. */
function fakeNav(opts: { fail?: boolean; noClear?: boolean } = {}) {
  const calls: (number | "clear")[] = [];
  const nav: {
    setAppBadge: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  } = {
    setAppBadge: async (n?: number) => {
      if (opts.fail) throw new Error("NotAllowedError");
      calls.push(n ?? 0);
    },
    clearAppBadge: async () => {
      if (opts.fail) throw new Error("NotAllowedError");
      calls.push("clear");
    },
  };
  if (opts.noClear) delete nav.clearAppBadge;
  return { nav, calls };
}

describe("the mode (notify.badge)", () => {
  test("every mode parses; anything else is the default, both", () => {
    for (const m of BADGE_MODES) expect(parseBadgeMode(m)).toBe(m);
    for (const bad of [undefined, null, "", "BOTH", "asks", 1, {}]) {
      expect(parseBadgeMode(bad)).toBe("both");
      expect(isBadgeMode(bad)).toBe(false);
    }
    expect(BADGE_DEFAULT).toBe("both");
  });

  test("the account registry takes the four modes and nothing else", () => {
    for (const m of BADGE_MODES) expect(checkPref("notify.badge", m)).toBe(m);
    expect(checkPref("notify.badge", "sometimes")).toBeUndefined();
    expect(checkPref("notify.badge", true)).toBeUndefined();
  });

  test("its binding is lk:notify-badge, default both", () => {
    const b = prefBindings().find((x) => x.key === "notify.badge")!;
    expect(b.fallback).toBe("both");
  });
});

describe("parseCounts", () => {
  test("two counts, floored and capped", () => {
    expect(parseCounts({ asks: 2, due: 3 })).toEqual({ asks: 2, due: 3 });
    expect(parseCounts({ asks: 2.7, due: 1e9, on: true })).toEqual({ asks: 2, due: BADGE_MAX });
  });
  test("anything else is null", () => {
    for (const bad of [null, 3, "x", {}, { asks: 1 }, { asks: -1, due: 0 }, { asks: NaN, due: 1 }])
      expect(parseCounts(bad)).toBeNull();
  });
});

describe("seenOn", () => {
  test("/review and /words show the due cards, /chat the asks", () => {
    expect(seenOn("/review")).toEqual({ due: true, asks: false });
    expect(seenOn("/words")).toEqual({ due: true, asks: false });
    expect(seenOn("/words/import")).toEqual({ due: true, asks: false });
    expect(seenOn("/ja/review")).toEqual({ due: true, asks: false });
    expect(seenOn("/chat/history")).toEqual({ due: false, asks: true });
  });
  test("other screens show neither", () => {
    for (const p of [
      "/",
      "/en",
      "/home",
      "/reviewer",
      "/wordsmith",
      "/preferences",
      null,
      undefined,
    ])
      expect(seenOn(p)).toEqual({ due: false, asks: false });
  });
});

describe("badgeCount", () => {
  const c: BadgeCounts = { asks: 2, due: 5 };
  test("per mode", () => {
    expect(badgeCount("both", c)).toBe(7);
    expect(badgeCount("ask-cards", c)).toBe(2);
    expect(badgeCount("due-cards", c)).toBe(5);
    expect(badgeCount("off", c)).toBe(0);
    expect(badgeCount("both", null)).toBe(0);
  });
  test("a part the open screen shows is left out", () => {
    expect(badgeCount("both", c, { due: true })).toBe(2);
    expect(badgeCount("both", c, { asks: true })).toBe(5);
    expect(badgeCount("due-cards", c, { due: true })).toBe(0);
  });
  test("capped", () => {
    expect(badgeCount("both", { asks: BADGE_MAX, due: BADGE_MAX })).toBe(BADGE_MAX);
  });
});

describe("applyDelta", () => {
  test("lowers, never below 0; ignores junk", () => {
    expect(applyDelta({ asks: 2, due: 1 }, { asks: -1 })).toEqual({ asks: 1, due: 1 });
    expect(applyDelta({ asks: 0, due: 1 }, { asks: -1, due: -3 })).toEqual({ asks: 0, due: 0 });
    expect(applyDelta({ asks: 1, due: 1 }, { asks: NaN, due: "x" as never })).toEqual({
      asks: 1,
      due: 1,
    });
  });
});

describe("setBadge", () => {
  test("a number sets it, 0 clears it", async () => {
    const { nav, calls } = fakeNav();
    expect(await setBadge(nav, 4)).toBe(true);
    expect(await setBadge(nav, 0)).toBe(true);
    expect(await setBadge(nav, 1e6)).toBe(true);
    expect(calls).toEqual([4, "clear", BADGE_MAX]);
  });
  test("no clearAppBadge: 0 is setAppBadge(0)", async () => {
    const { nav, calls } = fakeNav({ noClear: true });
    await setBadge(nav, 0);
    expect(calls).toEqual([0]);
  });
  test("no API, or it refuses: false, never thrown", async () => {
    expect(await setBadge(null, 3)).toBe(false);
    expect(await setBadge({}, 3)).toBe(false);
    expect(await setBadge(fakeNav({ fail: true }).nav, 3)).toBe(false);
  });
});

describe("the device's setting", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  let store: Map<string, string>;
  const events: string[] = [];
  const listener = (e: Event) => events.push(e.type);
  beforeEach(() => {
    store = new Map();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    events.length = 0;
    globalThis.addEventListener?.(BADGE_MODE_EVENT, listener);
    globalThis.addEventListener?.("lk:pref-write", listener);
    globalThis.addEventListener?.(BADGE_SEEN_EVENT, listener);
  });
  afterEach(() => {
    delete g.localStorage;
    globalThis.removeEventListener?.(BADGE_MODE_EVENT, listener);
    globalThis.removeEventListener?.("lk:pref-write", listener);
    globalThis.removeEventListener?.(BADGE_SEEN_EVENT, listener);
  });

  test("unset reads as both; a write is stored, noted for the sync and announced", () => {
    expect(readBadgeMode()).toBe("both");
    writeBadgeMode("due-cards");
    expect(store.get(BADGE_PREF_KEY)).toBe("due-cards");
    expect(readBadgeMode()).toBe("due-cards");
    expect(events).toContain("lk:pref-write");
    expect(events).toContain(BADGE_MODE_EVENT);
  });

  test("a junk stored value reads as both; unreadable storage too", () => {
    store.set(BADGE_PREF_KEY, "loud");
    expect(readBadgeMode()).toBe("both");
    g.localStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readBadgeMode()).toBe("both");
    expect(() => writeBadgeMode("off")).not.toThrow();
  });

  test("noteBadgeSeen fires the seen event with its delta", () => {
    let detail: unknown;
    const h = (e: Event) => (detail = (e as CustomEvent).detail);
    globalThis.addEventListener?.(BADGE_SEEN_EVENT, h);
    noteBadgeSeen({ asks: -1 });
    globalThis.removeEventListener?.(BADGE_SEEN_EVENT, h);
    expect(detail).toEqual({ asks: -1 });
  });
});

describe("badgeController (the page)", () => {
  function setup(o: { counts?: BadgeCounts | null; mode?: BadgeMode; path?: string } = {}) {
    const { nav, calls } = fakeNav();
    let t = 1_000_000;
    let mode: BadgeMode = o.mode ?? "both";
    let path = o.path ?? "/home";
    let counts = o.counts === undefined ? { asks: 2, due: 3 } : o.counts;
    const fetched: BadgeMode[] = [];
    const told: BadgeMode[] = [];
    const ctl = badgeController({
      nav,
      fetchCounts: async (m) => (fetched.push(m), counts),
      mode: () => mode,
      path: () => path,
      now: () => t,
      tellWorker: (m) => told.push(m),
    });
    return {
      ctl,
      calls,
      fetched,
      told,
      tick: (ms: number) => (t += ms),
      setMode: (m: BadgeMode) => (mode = m),
      setPath: (p: string) => (path = p),
      setCounts: (c: BadgeCounts | null) => (counts = c),
    };
  }

  test("open: fetches once and sets asks + due", async () => {
    const s = setup();
    await s.ctl.refresh();
    expect(s.fetched).toEqual(["both"]);
    expect(s.calls).toEqual([5]);
    expect(s.told).toEqual(["both"]);
  });

  test("visible again within 30 s: no new fetch; after: fetched again", async () => {
    const s = setup();
    await s.ctl.refresh();
    s.tick(1000);
    await s.ctl.refresh();
    expect(s.fetched.length).toBe(1);
    s.tick(BADGE_MIN_FETCH_MS);
    s.setCounts({ asks: 0, due: 1 });
    await s.ctl.refresh();
    expect(s.fetched.length).toBe(2);
    expect(s.calls).toEqual([5, 5, 1]);
  });

  test("concurrent refreshes share one fetch", async () => {
    const s = setup();
    await Promise.all([s.ctl.refresh(), s.ctl.refresh(true)]);
    expect(s.fetched.length).toBe(1);
  });

  test("an ask answered and a card graded lower it at once", async () => {
    const s = setup();
    await s.ctl.refresh();
    await s.ctl.seen({ asks: -1 });
    await s.ctl.seen({ due: -1 });
    expect(s.calls).toEqual([5, 4, 3]);
    expect(s.ctl.counts()).toEqual({ asks: 1, due: 2 });
  });

  test("the queue ran out: asks the server again at once", async () => {
    const s = setup();
    await s.ctl.refresh();
    s.setCounts({ asks: 2, due: 0 });
    await s.ctl.seen({ refresh: true });
    expect(s.fetched.length).toBe(2);
    expect(s.calls.at(-1)).toBe(2);
  });

  test("seen before any counts: nothing to lower, clears", async () => {
    const s = setup();
    await s.ctl.seen({ asks: -1 });
    expect(s.calls).toEqual(["clear"]);
  });

  test("on /review the due part is not counted", async () => {
    const s = setup({ path: "/review" });
    await s.ctl.refresh();
    expect(s.calls).toEqual([2]);
    s.setPath("/home");
    await s.ctl.render();
    expect(s.calls).toEqual([2, 5]);
  });

  test("mode per setting; off clears without fetching", async () => {
    const s = setup({ mode: "ask-cards" });
    await s.ctl.refresh();
    expect(s.calls).toEqual([2]);
    s.setMode("off");
    await s.ctl.refresh(true);
    expect(s.fetched).toEqual(["ask-cards"]);
    expect(s.calls).toEqual([2, "clear"]);
    expect(s.told).toEqual(["ask-cards", "off"]);
  });

  test("a failed fetch keeps the last counts", async () => {
    const s = setup();
    await s.ctl.refresh();
    s.setCounts(null);
    s.tick(BADGE_MIN_FETCH_MS);
    await s.ctl.refresh();
    expect(s.calls).toEqual([5, 5]);
  });

  test("a fetch that throws is swallowed", async () => {
    const { nav, calls } = fakeNav();
    const ctl = badgeController({
      nav,
      fetchCounts: async () => {
        throw new Error("offline");
      },
      mode: () => "both",
      path: () => "/",
      now: () => 0,
    });
    expect(await ctl.refresh()).toBe(true);
    expect(calls).toEqual(["clear"]);
  });

  test("no Badging API: never fetches", async () => {
    const fetchCounts = mock(async () => ({ asks: 1, due: 1 }));
    const ctl = badgeController({
      nav: null,
      fetchCounts,
      mode: () => "both",
      path: () => "/",
      now: () => 0,
    });
    expect(await ctl.refresh()).toBe(false);
    expect(fetchCounts).not.toHaveBeenCalled();
  });
});

describe("the counts on the server", () => {
  const SCHEMA = testSchema();
  const NOW = Date.parse("2026-11-09T06:00:00.000Z");
  const who = { id: "user-1", email: "u@example.com" };
  let d1: TestD1Database;

  const line = (id: string, user: string, ask: number, answer: string | null, at: number) =>
    d1
      .prepare(
        `INSERT INTO chat_line (user_id, id, thread, sender, text, at_ms, ask, answer)
         VALUES (?, ?, 'owner', 'agent', 'q', ?, ?, ?)`,
      )
      .bind(user, id, at, ask, answer)
      .run();
  const note = (url: string, email: string, due: string, deleted: string | null = null) =>
    d1
      .prepare(
        `INSERT INTO fsrs_notes (id, email, url, card, card_due, deleted_at) VALUES (?, ?, ?, '{}', ?, ?)`,
      )
      .bind(url, email, url, due, deleted)
      .run();
  const word = (term: string, email: string, due: string) =>
    d1
      .prepare(
        `INSERT INTO word_cards (email, list_id, term, card, card_due, updated_at) VALUES (?, 'l', ?, '{}', ?, 'x')`,
      )
      .bind(email, term, due)
      .run();

  beforeEach(async () => {
    clearBadgeCache();
    d1 = createTestD1(SCHEMA);
    const past = "2026-11-09T05:00:00.000Z";
    const later = "2026-11-10T05:00:00.000Z";
    await line("a1", who.id, 1, null, NOW - 1000); // open ask
    await line("a2", who.id, 1, null, NOW - 3600_000); // open ask
    await line("a3", who.id, 1, "Yes", NOW - 1000); // answered
    await line("a4", who.id, 0, null, NOW - 1000); // not an ask
    await line("a5", who.id, 1, null, NOW - 8 * 24 * 3600_000); // too old
    await line("a6", "user-2", 1, null, NOW - 1000); // someone else's
    await note("https://e.com/1", who.email, past);
    await note("https://e.com/2", who.email, later); // not due
    await note("https://e.com/3", who.email, past, past); // deleted
    await note("https://e.com/4", "x@example.com", past); // someone else's
    await word("hola", who.email, past);
    await word("gato", who.email, past);
    await word("perro", who.email, later);
    await word("hola", "x@example.com", past);
  });

  test("asks: open ask cards of the last 7 days; due: notes + words due now", async () => {
    expect(await queryBadgeCounts(d1, who, "both", NOW)).toEqual({ asks: 2, due: 3 });
  });

  test("only the parts the mode needs", async () => {
    expect(await queryBadgeCounts(d1, who, "ask-cards", NOW)).toEqual({ asks: 2, due: 0 });
    expect(await queryBadgeCounts(d1, who, "due-cards", NOW)).toEqual({ asks: 0, due: 3 });
    const prepare = mock(() => {
      throw new Error("no query for off");
    });
    expect(await queryBadgeCounts({ prepare } as never, who, "off", NOW)).toEqual({
      asks: 0,
      due: 0,
    });
  });

  test("an empty account is all zeros", async () => {
    expect(await queryBadgeCounts(d1, { id: "nobody", email: "n@e.com" }, "both", NOW)).toEqual({
      asks: 0,
      due: 0,
    });
  });

  test("cached per account and mode for 15 s", async () => {
    expect(await badgeCounts(d1, who, "both", NOW)).toEqual({ asks: 2, due: 3 });
    await line("a7", who.id, 1, null, NOW);
    expect(await badgeCounts(d1, who, "both", NOW + 1000)).toEqual({ asks: 2, due: 3 });
    expect(await badgeCounts(d1, who, "ask-cards", NOW + 1000)).toEqual({ asks: 3, due: 0 });
    expect(await badgeCounts(d1, who, "both", NOW + BADGE_CACHE_MS)).toEqual({ asks: 3, due: 3 });
  });

  test("the cache holds at most BADGE_CACHE_MAX accounts", async () => {
    const prepare = () => ({
      bind: () => ({ first: async () => ({ asks: 1, notes: 0, words: 0 }) }),
    });
    const db = { prepare } as never;
    for (let i = 0; i <= BADGE_CACHE_MAX; i++)
      await badgeCounts(db, { id: `u${i}`, email: `${i}@e.com` }, "ask-cards", NOW);
    // The first one was dropped: a second read queries again (and sees the new answer).
    const db2 = {
      prepare: () => ({ bind: () => ({ first: async () => ({ asks: 9 }) }) }),
    } as never;
    expect(await badgeCounts(db2, { id: "u1", email: "1@e.com" }, "ask-cards", NOW)).toEqual({
      asks: 1,
      due: 0,
    });
    expect(await badgeCounts(db2, { id: "u0", email: "0@e.com" }, "ask-cards", NOW)).toEqual({
      asks: 9,
      due: 0,
    });
  });

  test("a missing row reads as zeros", async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as never;
    expect(await queryBadgeCounts(db, who, "both", NOW)).toEqual({ asks: 0, due: 0 });
  });
});

// ── public/sw.js: the push side ──────────────────────────────────────────

type Handler = (e: Record<string, unknown>) => void;

async function loadSw(o: {
  host?: string;
  nav?: ReturnType<typeof fakeNav>["nav"] | null;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const src = await Bun.file(`${import.meta.dir}/../public/sw.js`).text();
  const handlers: Record<string, Handler> = {};
  const stored = new Map<string, string>();
  const host = o.host ?? "lianki.com";
  const self: Record<string, unknown> = {
    location: { hostname: host, origin: `https://${host}` },
    addEventListener: (t: string, h: Handler) => void (handlers[t] = h),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  if (o.nav !== null) self.navigator = o.nav;
  const caches = {
    keys: async () => [],
    delete: async () => true,
    open: async () => ({
      addAll: async () => {},
      put: async (k: string, r: Response) => void stored.set(k, await r.text()),
      match: async (k: string) => (stored.has(k) ? new Response(stored.get(k)) : undefined),
    }),
    match: async () => undefined,
  };
  const fetches: string[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    fetches.push(url);
    return o.fetch ? o.fetch(url, init) : new Response("{}", { status: 500 });
  };
  new Function("self", "caches", "fetch", src)(self, caches, fetchFn);
  const fire = async (type: string, extra: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    handlers[type]!({ waitUntil: (p: Promise<unknown>) => waits.push(p), ...extra });
    await Promise.all(waits);
    return waits.length;
  };
  const push = (payload: unknown) =>
    fire("push", {
      data:
        payload === undefined
          ? null
          : {
              json: () => {
                if (typeof payload === "string") return JSON.parse(payload);
                return payload;
              },
            },
    });
  return { fire, push, fetches, stored };
}

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

describe("the service worker's badge", () => {
  test("a push with a number sets it", async () => {
    const { nav, calls } = fakeNav();
    const sw = await loadSw({ nav });
    await sw.push({ badge: 7 });
    await sw.push({ badge: 0 });
    expect(calls).toEqual([7, "clear"]);
    expect(sw.fetches).toEqual([]);
  });

  test("a push with counts: the page's last mode decides (both before any)", async () => {
    const { nav, calls } = fakeNav();
    const sw = await loadSw({ nav });
    await sw.push({ badge: { asks: 2, due: 3 } });
    await sw.fire("message", { data: { type: "badge-mode", mode: "due-cards" } });
    await sw.push({ badge: { asks: 2, due: 3 } });
    await sw.push({ badge: { asks: 2, due: 3, mode: "ask-cards" } });
    await sw.push({ badge: { asks: 2, due: 3, mode: "off" } });
    expect(calls).toEqual([5, 3, 2, "clear"]);
    expect(sw.stored.get("/__lk/badge-mode")).toBe("due-cards");
  });

  test("a junk mode message is ignored", async () => {
    const { nav } = fakeNav();
    const sw = await loadSw({ nav });
    await sw.fire("message", { data: { type: "badge-mode", mode: "loud" } });
    expect(sw.stored.size).toBe(0);
  });

  test("a push without counts asks /api/badge with the page's mode", async () => {
    const { nav, calls } = fakeNav();
    const sw = await loadSw({
      nav,
      fetch: async () => json({ on: true, mode: "both", asks: 1, due: 3, count: 4 }),
    });
    await sw.push(undefined);
    expect(sw.fetches).toEqual(["/api/badge"]);
    await sw.fire("message", { data: { type: "badge-mode", mode: "both" } });
    await sw.push({ title: "hello" });
    expect(sw.fetches).toEqual(["/api/badge", "/api/badge?mode=both"]);
    expect(calls).toEqual([4, 4]);
  });

  test("the flag off clears; signed out or offline leaves it", async () => {
    const { nav, calls } = fakeNav();
    let answer: () => Promise<Response> = async () => json({ on: false });
    const sw = await loadSw({ nav, fetch: () => answer() });
    await sw.push(undefined);
    answer = async () => new Response("{}", { status: 401 });
    await sw.push(undefined);
    answer = async () => {
      throw new Error("offline");
    };
    await sw.push(undefined);
    expect(calls).toEqual(["clear"]);
  });

  test("mode off: clears without asking the server", async () => {
    const { nav, calls } = fakeNav();
    const sw = await loadSw({ nav });
    await sw.fire("message", { data: { type: "badge-mode", mode: "off" } });
    await sw.push(undefined);
    expect(calls).toEqual(["clear"]);
    expect(sw.fetches).toEqual([]);
  });

  test("a payload that is not JSON still updates from the server", async () => {
    const { nav, calls } = fakeNav();
    const sw = await loadSw({ nav, fetch: async () => json({ on: true, count: 2 }) });
    await sw.push("not json{");
    expect(calls).toEqual([2]);
  });

  test("no Badging API, or it refuses: nothing, nothing thrown", async () => {
    const none = await loadSw({ nav: null, fetch: async () => json({ on: true, count: 2 }) });
    await none.push(undefined);
    expect(none.fetches).toEqual([]);
    const refused = fakeNav({ fail: true });
    const sw = await loadSw({ nav: refused.nav });
    await sw.push({ badge: 3 });
    expect(refused.calls).toEqual([]);
    const noClear = fakeNav({ noClear: true });
    const sw2 = await loadSw({ nav: noClear.nav });
    await sw2.push({ badge: 0 });
    expect(noClear.calls).toEqual([0]);
  });

  test("a box does nothing", async () => {
    const { nav, calls } = fakeNav();
    const sw = await loadSw({ host: "my-0123456789abcdef.lianki.com", nav });
    expect(await sw.push({ badge: 3 })).toBe(0);
    expect(await sw.fire("message", { data: { type: "badge-mode", mode: "off" } })).toBe(0);
    expect(calls).toEqual([]);
  });
});
