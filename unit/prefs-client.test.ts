import { expect, test } from "bun:test";
import { startPrefSync } from "../lib/prefs/client";
import { PREF_WRITE_EVENT } from "../packages/ui-state/src/account";
import { stubGlobals } from "./support/globals";

test("preference browser wiring handles unavailable storage and reuses an existing engine", async () => {
  let pulls = 0;
  const existing = {
    pull: async () => {
      pulls++;
    },
  };
  const restore = stubGlobals({ window: undefined, __lkPrefSync: existing });
  try {
    expect(startPrefSync()).toBeNull();
  } finally {
    restore();
  }
  const inaccessible = stubGlobals({
    window: {
      get localStorage() {
        throw Error("disabled");
      },
    },
    __lkPrefSync: undefined,
  });
  try {
    expect(startPrefSync()).toBeNull();
  } finally {
    inaccessible();
  }
  const reused = stubGlobals({ window: {}, __lkPrefSync: existing });
  try {
    expect(startPrefSync()).toBe(existing as any);
    expect(pulls).toBe(1);
  } finally {
    reused();
  }
});

test("browser events drive preference scans, online pulls and background flushes without polling", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  };
  const win = Object.assign(new EventTarget(), { localStorage: storage });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let reads = 0;
  let fail = true;
  const warnings: unknown[] = [];
  const restore = stubGlobals({
    window: win,
    document: doc,
    localStorage: storage,
    __lkPrefSync: undefined,
    fetch: async (_u: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        expect(new Headers(init.headers).get("x-lk-prefs-user")).toBe("account-a");
        const { ops } = JSON.parse(String(init.body));
        return Response.json({
          user: "account-a",
          prefs: Object.fromEntries(
            ops.map((op: any) => [op.key, { value: op.value, hlc: op.hlc }]),
          ),
        });
      }
      reads++;
      if (fail) return new Response("", { status: 503 });
      return Response.json({ user: "account-a", prefs: {}, cursor: 0 });
    },
  });
  const warn = console.warn;
  console.warn = (...args) => {
    warnings.push(args);
  };
  try {
    const sync = startPrefSync()!;
    await sync.pull();
    expect(warnings.length).toBeGreaterThan(0);
    fail = false;
    win.dispatchEvent(new Event("online"));
    await sync.pull();
    expect(reads).toBeGreaterThanOrEqual(2);
    values.set("lk:words-show-all", "1");
    win.dispatchEvent(new Event(PREF_WRITE_EVENT));
    await Bun.sleep(10);
    await sync.flush();
    const before = reads;
    doc.dispatchEvent(new Event("visibilitychange"));
    await sync.pull();
    expect(reads).toBeGreaterThan(before);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("pagehide"));
    await sync.flush();
  } finally {
    console.warn = warn;
    restore();
  }
});
