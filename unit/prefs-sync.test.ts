import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { checkPref, patchBody } from "@/lib/prefs/schema";
import { UserPrefsD1Repo } from "@/lib/repos/userPrefsD1";
import {
  createPrefSync,
  SYNC_KEY,
  type PrefBinding,
  type PrefSyncOptions,
} from "@lianki/ui-state/account";

/**
 * The account sync engine (packages/ui-state/src/account.ts) against the real
 * repo on an in-memory D1: two "devices", each with its own localStorage,
 * talking to one server. Timers are run by hand.
 */
const SCHEMA = testSchema();
let d1: TestD1Database;
let clock: number;
let signedIn: string | null;

function server(): PrefSyncOptions["fetch"] {
  return async (url, init) => {
    if (!signedIn) return new Response("{}", { status: 401 });
    const repo = new UserPrefsD1Repo(d1 as unknown as D1Like, signedIn, () => clock);
    if (init?.method === "PATCH") {
      const body = patchBody.parse(JSON.parse(String(init.body)));
      return Response.json({ user: signedIn, ...(await repo.write(body.ops)) });
    }
    const since = Number(new URL(url, "https://x").searchParams.get("since") ?? 0);
    return Response.json({ user: signedIn, ...(await repo.read(since)) });
  };
}

function device(name: string) {
  const ls = new Map<string, string>();
  const storage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
  };
  const timers: (() => void)[] = [];
  const bool = (key: string, local: string, fallback: boolean): PrefBinding => ({
    key,
    fallback,
    get: () => (ls.has(local) ? ls.get(local) === "1" : undefined),
    set: (v) => void ls.set(local, v ? "1" : "0"),
  });
  const bindings = [
    bool("words.showAll", "lk:words-show-all", false),
    bool("words.gradeTones", "lk:words-grade-tones", true),
    {
      key: "motion.animations",
      fallback: "on",
      get: () => {
        const s = JSON.parse(ls.get("lk:pref:motion") ?? "null")?.state?.animations;
        return s === "system" ? undefined : s;
      },
      set: (v: unknown) =>
        void ls.set("lk:pref:motion", JSON.stringify({ state: { animations: v }, version: 1 })),
    },
  ];
  let n = 0;
  const sync = createPrefSync({
    bindings: () => bindings,
    validate: checkPref,
    fetch: server(),
    storage,
    now: () => clock,
    random: () => ((n = (n * 7 + 3) % 36), n / 36),
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  const runTimers = async () => {
    while (timers.length) timers.shift()!();
    await sync.push();
  };
  return { name, ls, sync, runTimers };
}

const animations = (d: ReturnType<typeof device>) =>
  JSON.parse(d.ls.get("lk:pref:motion") ?? "null")?.state?.animations;

beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  clock = 1_000_000;
  signedIn = "owner";
  for (const id of ["owner", "friend"])
    d1.raw()
      .prepare(
        "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, 1, '2026-10-31', '2026-10-31')",
      )
      .run(id, `${id}@example.com`);
});

describe("account prefs: first sync (server wins, local fills gaps)", () => {
  it("the iPhone's 'turn off animations' reaches a fresh device", async () => {
    const phone = device("phone");
    phone.ls.set("lk:pref:motion", JSON.stringify({ state: { animations: "off" }, version: 1 }));
    await phone.sync.pull(); // first sync: the server has nothing, so the phone's choice goes up
    const mac = device("mac");
    await mac.sync.pull();
    expect(animations(mac)).toBe("off");
  });

  it("the server wins over a device's old local value; defaults are never uploaded", async () => {
    const phone = device("phone");
    phone.ls.set("lk:words-show-all", "1");
    await phone.sync.pull();
    const mac = device("mac");
    mac.ls.set("lk:words-show-all", "0"); // an old local value, older than the account's
    mac.ls.set("lk:words-grade-tones", "1"); // equals the default: stays a gap
    await mac.sync.pull();
    expect(mac.ls.get("lk:words-show-all")).toBe("1");
    const { prefs } = await new UserPrefsD1Repo(d1 as unknown as D1Like, "owner").read();
    expect(Object.keys(prefs)).toEqual(["words.showAll"]);
  });
});

describe("account prefs: after the first sync", () => {
  it("a change is pushed after the debounce and pulled by the other device", async () => {
    const phone = device("phone");
    const mac = device("mac");
    await phone.sync.pull();
    await mac.sync.pull();
    clock += 1000;
    phone.ls.set("lk:words-show-all", "1");
    expect(phone.sync.scan()).toBe(1);
    await phone.runTimers();
    expect(phone.sync.load().outbox).toEqual({});
    clock += 1000;
    await mac.sync.pull(); // the tab is shown
    expect(mac.ls.get("lk:words-show-all")).toBe("1");
  });

  it("per field, last write wins: two devices changing different settings keep both", async () => {
    const phone = device("phone");
    const mac = device("mac");
    await phone.sync.pull();
    await mac.sync.pull();
    clock += 1000;
    phone.ls.set("lk:words-show-all", "1");
    phone.sync.scan();
    mac.ls.set("lk:words-grade-tones", "0");
    mac.sync.scan();
    await phone.runTimers();
    await mac.runTimers();
    await phone.sync.pull();
    await mac.sync.pull();
    for (const d of [phone, mac]) {
      expect(d.ls.get("lk:words-show-all")).toBe("1");
      expect(d.ls.get("lk:words-grade-tones")).toBe("0");
    }
  });

  it("the same field on two devices: the later change wins on both", async () => {
    const phone = device("phone");
    const mac = device("mac");
    await phone.sync.pull();
    await mac.sync.pull();
    clock += 1000;
    mac.ls.set("lk:words-show-all", "0");
    mac.sync.scan();
    clock += 1000;
    phone.ls.set("lk:words-show-all", "1");
    phone.sync.scan();
    await phone.runTimers(); // the later change arrives first
    await mac.runTimers(); // the earlier one loses, and the mac adopts the winner
    expect(mac.ls.get("lk:words-show-all")).toBe("1");
    await phone.sync.pull();
    expect(phone.ls.get("lk:words-show-all")).toBe("1");
  });

  it("offline: the change waits in the outbox and goes up later", async () => {
    const phone = device("phone");
    await phone.sync.pull();
    clock += 1000;
    signedIn = null; // the request fails (here: 401) — nothing is lost
    phone.ls.set("lk:words-show-all", "1");
    phone.sync.scan();
    await phone.runTimers();
    expect(Object.keys(phone.sync.load().outbox)).toEqual(["words.showAll"]); // waiting
    signedIn = "owner";
    await phone.sync.pull();
    const { prefs } = await new UserPrefsD1Repo(d1 as unknown as D1Like, "owner").read();
    expect(prefs["words.showAll"]?.value).toBe(true);
  });

  it("another account on the device: pending changes are dropped, its values pulled", async () => {
    const phone = device("phone");
    await phone.sync.pull();
    signedIn = "friend";
    const friendDevice = device("friend");
    friendDevice.ls.set("lk:words-show-all", "1");
    await friendDevice.sync.pull();
    clock += 1000;
    phone.ls.set("lk:words-grade-tones", "0");
    phone.sync.scan();
    await phone.sync.pull(); // now signed in as the friend
    expect(phone.sync.load().userId).toBe("friend");
    expect(phone.ls.get("lk:words-show-all")).toBe("1");
    const owner = await new UserPrefsD1Repo(d1 as unknown as D1Like, "owner").read();
    const friend = await new UserPrefsD1Repo(d1 as unknown as D1Like, "friend").read();
    expect(owner.prefs["words.gradeTones"]).toBeUndefined();
    expect(friend.prefs["words.gradeTones"]).toBeUndefined();
  });

  it("a value from the server that fails its schema is never applied", async () => {
    const phone = device("phone");
    await phone.sync.pull();
    await d1.exec(
      `INSERT INTO user_prefs VALUES ('owner', 'words.showAll', '"https://x.ts.net"', ${clock + 5}, 0, 'zzzzzzzz', ${clock})`,
    );
    clock += 1000;
    await phone.sync.pull();
    expect(phone.ls.get("lk:words-show-all")).toBeUndefined();
  });

  it("signed out: nothing is sent, local values stay", async () => {
    signedIn = null;
    const phone = device("phone");
    phone.ls.set("lk:words-show-all", "1");
    await phone.sync.pull();
    expect(phone.ls.get("lk:words-show-all")).toBe("1");
    expect(phone.ls.get(SYNC_KEY)).toBeDefined();
    expect(phone.sync.load().userId).toBeNull();
  });
});
