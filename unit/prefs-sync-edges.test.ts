import { describe, expect, it } from "bun:test";
import { checkPref } from "@/lib/prefs/schema";
import {
  createPrefSync,
  notePrefApplied,
  notePrefWrite,
  PREF_APPLIED_EVENT,
  PREF_WRITE_EVENT,
  SYNC_KEY,
  type PrefBinding,
  type PrefSyncOptions,
} from "@lianki/ui-state/account";

/** The sync engine's failure paths (packages/ui-state/src/account.ts). */
const binding = (over: Partial<PrefBinding> = {}): PrefBinding => ({
  key: "words.showAll",
  fallback: false,
  get: () => true,
  set: () => {},
  ...over,
});

function make(fetch: PrefSyncOptions["fetch"], b: PrefBinding[], seed?: string) {
  const ls = new Map<string, string>(seed ? [[SYNC_KEY, seed]] : []);
  const logs: string[] = [];
  const sync = createPrefSync({
    bindings: () => b,
    validate: checkPref,
    fetch,
    storage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => void ls.set(k, v) },
    now: () => 1_000_000,
    setTimer: () => 0,
    clearTimer: () => {},
    log: (ev) => logs.push(ev),
  });
  return { ls, sync, logs };
}

describe("account prefs: failures and edges", () => {
  it("a broken record starts over; a server error is logged, not thrown", async () => {
    const { sync, logs } = make(
      async () => new Response("no", { status: 500 }),
      [binding()],
      "{bad",
    );
    expect(sync.load().deviceId).toMatch(/^[a-z0-9]{16}$/);
    await sync.pull();
    expect(logs).toContain("prefs-pull-failed");
  });

  it("blocked storage and a throwing binding: nothing throws", async () => {
    const broken = createPrefSync({
      bindings: () => [
        binding({
          get: () => {
            throw new Error("x");
          },
        }),
      ],
      validate: checkPref,
      fetch: async () => new Response("", { status: 401 }),
      storage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(broken.scan()).toBe(0);
    await broken.pull();
  });

  it("refused keys leave the outbox; a failed push keeps it; flush pushes at once", async () => {
    let fail = true;
    let value: unknown = false;
    const fetch: PrefSyncOptions["fetch"] = async (_u, init) => {
      if (init?.method !== "PATCH") return Response.json({ user: "owner", prefs: {}, cursor: 1 });
      if (fail) return new Response("", { status: 503 });
      return Response.json({ user: "owner", prefs: {}, rejected: ["words.showAll"] });
    };
    const { sync, logs } = make(fetch, [binding({ get: () => value })]);
    await sync.pull();
    value = true;
    await sync.flush(true);
    expect(logs).toContain("prefs-push-failed");
    expect(Object.keys(sync.load().outbox)).toEqual(["words.showAll"]);
    fail = false;
    await sync.flush();
    expect(logs).toContain("prefs-rejected");
    expect(sync.load().outbox).toEqual({});
  });

  it("a server value that fails its schema, or that the binding cannot take, is skipped", async () => {
    const hlc = { timestamp: 5, counter: 0, deviceId: "zzzzzzzz" };
    let value: unknown = "https://x.ts.net";
    const fetch: PrefSyncOptions["fetch"] = async () =>
      Response.json({ user: "owner", prefs: { "words.showAll": { value, hlc } }, cursor: 1 });
    const bad = make(fetch, [binding()]);
    await bad.sync.pull();
    expect(bad.logs).toContain("prefs-bad-value");
    value = true;
    const { sync } = make(fetch, [
      binding({
        set: () => {
          throw new Error("nope");
        },
      }),
    ]);
    await sync.pull();
    expect(sync.load().hlc["words.showAll"]).toBeUndefined();
  });

  it("an account switch with a cursor refetches everything", async () => {
    const urls: string[] = [];
    let user = "owner";
    const fetch: PrefSyncOptions["fetch"] = async (u, init) => {
      if (init?.method !== "PATCH") urls.push(u);
      return Response.json({ user, prefs: {}, cursor: 7 });
    };
    const { sync, logs } = make(fetch, [binding()]);
    await sync.pull();
    user = "friend";
    await sync.pull();
    expect(urls).toEqual(["/api/prefs", "/api/prefs?since=7", "/api/prefs"]);
    expect(logs).toContain("prefs-account-switch");
  });

  it("the page events: a write and an applied value are announced on globalThis", () => {
    const seen: string[] = [];
    const g = globalThis as unknown as EventTarget;
    const on = (e: Event) => void seen.push(e.type);
    g.addEventListener(PREF_WRITE_EVENT, on);
    g.addEventListener(PREF_APPLIED_EVENT, on);
    notePrefWrite();
    notePrefApplied("words.showAll");
    g.removeEventListener(PREF_WRITE_EVENT, on);
    g.removeEventListener(PREF_APPLIED_EVENT, on);
    expect(seen).toEqual([PREF_WRITE_EVENT, PREF_APPLIED_EVENT]);
  });
});
