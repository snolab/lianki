import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import {
  closedFlags,
  defaultFlags,
  FLAG_KEYS,
  FLAG_OLD_KEYS,
  FLAGS,
  flagIn,
  isFlagKey,
} from "@/lib/flags";
import {
  clearFlagCache,
  FLAG_CACHE_MS,
  FlagError,
  flagLog,
  flagOn,
  listFlags,
  loadFlags,
  readFlags,
  setFlag,
} from "@/lib/flags-store";
import { sameOriginJsonPost } from "@/lib/security/same-origin";

/**
 * Owner feature flags. What matters: only registry keys exist; every default is
 * off; an unreadable flag is off; a change takes effect within the cache
 * window with no deploy; every change is logged with who and when; the toggle
 * refuses anything that is not a same-origin JSON POST.
 */
const NOW = new Date("2026-11-02T07:00:00.000Z");
const BY = "owner@x.com";

const saved = { ...process.env };
beforeEach(() => clearFlagCache());
afterEach(() => {
  process.env = { ...saved };
  clearFlagCache();
});

describe("registry", () => {
  test("the payment flags exist, defaults are off but the few default-on ones, unknown keys are not flags", () => {
    expect(FLAG_KEYS).toContain("payments.stripe.live");
    expect(FLAG_KEYS).toContain("payments.komoju.live");
    // Default-on is only for a flag that keeps something already live switchable.
    const on = FLAG_KEYS.filter((k) => FLAGS[k].default);
    expect(on).toEqual(["stt.polish"]);
    for (const k of FLAG_KEYS) expect(FLAGS[k].description.length).toBeGreaterThan(0);
    expect(FLAGS["payments.stripe.live"].default).toBe(false);
    expect(
      Object.entries(defaultFlags())
        .filter(([, v]) => v)
        .map(([k]) => k),
    ).toEqual(on);
    expect(Object.values(closedFlags()).every((v) => v === false)).toBe(true);
    expect(isFlagKey("payments.stripe.live")).toBe(true);
    for (const k of ["payments.paypal.live", "", "toString", "__proto__", 1, null, undefined])
      expect(isFlagKey(k)).toBe(false);
  });

  test("flagIn is on only for exactly true", () => {
    expect(flagIn({ "payments.stripe.live": true }, "payments.stripe.live")).toBe(true);
    expect(flagIn({ "payments.stripe.live": false }, "payments.stripe.live")).toBe(false);
    expect(flagIn({}, "payments.stripe.live")).toBe(false);
    expect(flagIn(null, "payments.stripe.live")).toBe(false);
    expect(flagIn(undefined, "payments.stripe.live")).toBe(false);
    expect(flagIn({ "payments.stripe.live": 1 as never }, "payments.stripe.live")).toBe(false);
  });
});

describe("store", () => {
  let d1: ReturnType<typeof createTestD1>;
  beforeEach(() => {
    d1 = createTestD1(testSchema());
  });

  test("a fresh database reads every flag at its default (off, but the default-on ones)", async () => {
    expect(await loadFlags(d1)).toEqual(defaultFlags());
    expect(await listFlags(d1)).toEqual(
      FLAG_KEYS.map((key) => ({
        key,
        description: FLAGS[key].description,
        enabled: FLAGS[key].default as boolean,
        updatedAt: null,
        updatedBy: null,
      })),
    );
    expect(await flagLog(d1)).toEqual([]);
  });

  test("setFlag writes the row and a log entry, who and when", async () => {
    const row = await setFlag(d1, "payments.stripe.live", true, BY, NOW);
    expect(row).toMatchObject({ key: "payments.stripe.live", enabled: true, updatedBy: BY });
    expect((await loadFlags(d1))["payments.stripe.live"]).toBe(true);
    expect((await loadFlags(d1))["payments.komoju.live"]).toBe(false);
    const later = new Date(NOW.getTime() + 60_000);
    await setFlag(d1, "payments.stripe.live", false, "other@x.com", later);
    expect((await loadFlags(d1))["payments.stripe.live"]).toBe(false);
    const listed = (await listFlags(d1)).find((f) => f.key === "payments.stripe.live");
    expect(listed).toMatchObject({
      enabled: false,
      updatedAt: later.toISOString(),
      updatedBy: "other@x.com",
    });
    expect(await flagLog(d1)).toEqual([
      { key: "payments.stripe.live", enabled: false, at: later.toISOString(), by: "other@x.com" },
      { key: "payments.stripe.live", enabled: true, at: NOW.toISOString(), by: BY },
    ]);
    expect(await flagLog(d1, 1)).toHaveLength(1);
    expect(await flagLog(d1, 0)).toHaveLength(1); // at least one
  });

  test("unknown keys and non-boolean values are refused before D1 is touched", async () => {
    for (const [key, enabled] of [
      ["payments.paypal.live", true],
      ["__proto__", true],
      [42, true],
      ["payments.stripe.live", "true"],
      ["payments.stripe.live", 1],
      ["payments.stripe.live", null],
    ] as const) {
      await expect(setFlag(d1, key, enabled, BY, NOW)).rejects.toBeInstanceOf(FlagError);
    }
    await expect(setFlag(d1, "payments.stripe.live", true, "  ", NOW)).rejects.toThrow("Who");
    expect(await flagLog(d1)).toEqual([]);
    expect(await loadFlags(d1)).toEqual(defaultFlags());
  });

  test("a stored row overrides a default-on flag, both ways", async () => {
    expect((await loadFlags(d1))["stt.polish"]).toBe(true);
    await setFlag(d1, "stt.polish", false, BY, NOW);
    expect((await loadFlags(d1))["stt.polish"]).toBe(false);
    expect((await listFlags(d1)).find((f) => f.key === "stt.polish")?.enabled).toBe(false);
    await setFlag(d1, "stt.polish", true, BY, NOW);
    expect((await loadFlags(d1))["stt.polish"]).toBe(true);
  });

  test("migration 0067 carries stt.polish-off over inverted, and leaves a stt.polish row alone", async () => {
    const sql = readFileSync("db/migrations/0067_stt_polish_flag.sql", "utf8");
    const put = (key: string, on: number) =>
      d1
        .raw()
        .prepare(
          "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)",
        )
        .run(key, on, NOW.toISOString(), BY);
    put("stt.polish-off", 1);
    d1.raw().exec(sql);
    expect((await loadFlags(d1))["stt.polish"]).toBe(false);
    expect((await flagLog(d1))[0]).toMatchObject({ key: "stt.polish", enabled: false });
    // Run again (or polish-off off later): an existing stt.polish row wins.
    d1.raw().prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'stt.polish-off'").run();
    d1.raw().exec(sql);
    expect((await loadFlags(d1))["stt.polish"]).toBe(false);
    // polish-off stored off: polish stays on.
    const fresh = createTestD1(testSchema());
    fresh
      .raw()
      .prepare(
        "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('stt.polish-off', 0, ?, ?)",
      )
      .run(NOW.toISOString(), BY);
    fresh.raw().exec(sql);
    expect((await loadFlags(fresh))["stt.polish"]).toBe(true);
    // Nothing stored: no row written, the default (on) stands.
    const none = createTestD1(testSchema());
    none.raw().exec(sql);
    expect(await flagLog(none)).toEqual([]);
    expect((await loadFlags(none))["stt.polish"]).toBe(true);
  });

  test("a stored row for a key the registry no longer knows is ignored; only 1 is on", async () => {
    d1.raw()
      .prepare(
        "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)",
      )
      .run("payments.gone.live", NOW.toISOString(), BY);
    d1.raw()
      .prepare(
        "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, 0, ?, ?)",
      )
      .run("payments.komoju.live", NOW.toISOString(), BY);
    const v = await loadFlags(d1);
    expect(Object.keys(v).sort()).toEqual([...FLAG_KEYS].sort());
    expect(v["payments.komoju.live"]).toBe(false);
    expect((await listFlags(d1)).map((f) => f.key)).toEqual(FLAG_KEYS);
  });

  describe("a renamed flag keeps its stored state", () => {
    const put = (key: string, enabled: 0 | 1) =>
      d1
        .raw()
        .prepare(
          "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)",
        )
        .run(key, enabled, NOW.toISOString(), BY);
    const OLD = "live.custom-frontend";

    test("an old key is never a registry key, and points at one", () => {
      expect(FLAG_OLD_KEYS["my-box"]).toBe(OLD);
      for (const [key, old] of Object.entries(FLAG_OLD_KEYS)) {
        expect(isFlagKey(key)).toBe(true);
        expect(isFlagKey(old)).toBe(false);
      }
    });

    test("no row under the new key: the old key's value, on or off", async () => {
      put(OLD, 1);
      expect((await loadFlags(d1))["my-box"]).toBe(true);
      const on = (await listFlags(d1)).find((f) => f.key === "my-box");
      expect(on).toMatchObject({ enabled: true, updatedAt: NOW.toISOString(), updatedBy: BY });

      d1.raw().prepare("UPDATE feature_flags SET enabled = 0 WHERE key = ?").run(OLD);
      expect((await loadFlags(d1))["my-box"]).toBe(false);
    });

    test("no row under either key is off", async () => {
      expect((await loadFlags(d1))["my-box"]).toBe(false);
    });

    test("a row under the new key wins, even off over an old on", async () => {
      put(OLD, 1);
      put("my-box", 0);
      expect((await loadFlags(d1))["my-box"]).toBe(false);
      expect((await listFlags(d1)).find((f) => f.key === "my-box")?.enabled).toBe(false);
    });

    test("setFlag writes the new key, leaves the old row, and refuses the old key", async () => {
      put(OLD, 1);
      await setFlag(d1, "my-box", false, BY, NOW);
      expect((await loadFlags(d1))["my-box"]).toBe(false);
      const old = d1.raw().prepare("SELECT enabled FROM feature_flags WHERE key = ?").get(OLD);
      expect(old).toEqual({ enabled: 1 });
      await expect(setFlag(d1, OLD, true, BY, NOW)).rejects.toBeInstanceOf(FlagError);
    });
  });

  test("the table refuses a value other than 0 or 1", () => {
    expect(() =>
      d1
        .raw()
        .prepare(
          "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, 2, ?, ?)",
        )
        .run("payments.stripe.live", NOW.toISOString(), BY),
    ).toThrow();
  });
});

describe("readFlags: cache window and fail-closed", () => {
  test("the cache is the isolate's, not this module copy's: route handlers and pages share it", async () => {
    // The build gives route handlers and page rendering each a copy of
    // lib/flags-store; a copy finds the one cache on globalThis.
    const shared = () =>
      (globalThis as { __lkFlagCache?: { cache: unknown; generation: number } }).__lkFlagCache;
    const d1 = createTestD1(testSchema());
    let reads = 0;
    const db = () => {
      reads++;
      return d1;
    };
    const now = () => 1_000_000;
    await readFlags(db, now);
    expect(shared()?.cache).toEqual({ at: 1_000_000, values: expect.any(Object) });
    d1.raw()
      .prepare(
        "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)",
      )
      .run("payments.stripe.live", NOW.toISOString(), BY);
    // What another copy does to the shared state (a write on /dev/flags clears it)…
    shared()!.cache = null;
    shared()!.generation++;
    // …this copy sees at once.
    expect((await readFlags(db, now))["payments.stripe.live"]).toBe(true);
    expect(reads).toBe(2);
  });

  test("cached for FLAG_CACHE_MS (at most 30 s), then re-read: a change lands without a deploy", async () => {
    expect(FLAG_CACHE_MS).toBeLessThanOrEqual(30_000);
    const d1 = createTestD1(testSchema());
    let reads = 0;
    const db = () => {
      reads++;
      return d1;
    };
    let t = 1_000_000;
    const now = () => t;
    expect((await readFlags(db, now))["payments.stripe.live"]).toBe(false);
    // Changed elsewhere (another isolate): this one keeps its snapshot a while…
    d1.raw()
      .prepare(
        "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)",
      )
      .run("payments.stripe.live", NOW.toISOString(), BY);
    t += FLAG_CACHE_MS - 1;
    expect((await readFlags(db, now))["payments.stripe.live"]).toBe(false);
    expect(reads).toBe(1);
    // …and has it at the end of the window.
    t += 1;
    expect((await readFlags(db, now))["payments.stripe.live"]).toBe(true);
    expect(reads).toBe(2);
    // A clock that went backwards does not keep a stale snapshot.
    t -= 5_000;
    await readFlags(db, now);
    expect(reads).toBe(3);
  });

  test("a write in this isolate drops its cache at once", async () => {
    const d1 = createTestD1(testSchema());
    const t = 5_000_000;
    expect(
      (
        await readFlags(
          () => d1,
          () => t,
        )
      )["payments.komoju.live"],
    ).toBe(false);
    await setFlag(d1, "payments.komoju.live", true, BY, NOW);
    expect(
      (
        await readFlags(
          () => d1,
          () => t,
        )
      )["payments.komoju.live"],
    ).toBe(true);
  });

  test("the returned snapshot is a copy: changing it changes nothing", async () => {
    const d1 = createTestD1(testSchema());
    const a = await readFlags(
      () => d1,
      () => 1,
    );
    a["payments.stripe.live"] = true;
    expect(
      (
        await readFlags(
          () => d1,
          () => 1,
        )
      )["payments.stripe.live"],
    ).toBe(false);
  });

  test("concurrent misses share one query", async () => {
    const d1 = createTestD1(testSchema());
    let reads = 0;
    const db = () => {
      reads++;
      return d1;
    };
    await Promise.all([readFlags(db, () => 1), readFlags(db, () => 1), readFlags(db, () => 1)]);
    expect(reads).toBe(1);
  });

  test("a D1 error reads as all off, is not cached, and the next call retries", async () => {
    const d1 = createTestD1(testSchema());
    await setFlag(d1, "payments.stripe.live", true, BY, NOW);
    clearFlagCache();
    const broken: D1Like = {
      prepare: () => {
        throw new Error("D1 down");
      },
      exec: async () => undefined,
    };
    const errors: string[] = [];
    const realError = console.error;
    console.error = (m: string) => void errors.push(m);
    try {
      expect(
        await readFlags(
          () => broken,
          () => 1,
        ),
      ).toEqual(closedFlags());
      // A getter that throws (no request context) is off too.
      expect(
        await readFlags(
          () => {
            throw new Error("no context");
          },
          () => 1,
        ),
      ).toEqual(closedFlags());
    } finally {
      console.error = realError;
    }
    expect(errors.some((e) => e.includes("flags.read-failed"))).toBe(true);
    // Not cached: the next read, with D1 back, sees the real value.
    expect(
      (
        await readFlags(
          () => d1,
          () => 1,
        )
      )["payments.stripe.live"],
    ).toBe(true);
  });

  test("a read that started before a write never fills the cache with the old value", async () => {
    const d1 = createTestD1(testSchema());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: D1Like = {
      prepare: (q) => {
        const stmt = d1.prepare(q);
        return {
          ...stmt,
          bind: stmt.bind.bind(stmt),
          first: stmt.first.bind(stmt),
          run: stmt.run.bind(stmt),
          all: async <T>() => {
            const r = await stmt.all<T>();
            await gate;
            return r;
          },
        };
      },
      exec: (q) => d1.exec(q),
    };
    const stale = readFlags(
      () => slow,
      () => 1,
    );
    await setFlag(d1, "payments.stripe.live", true, BY, NOW); // clears the cache
    release();
    expect((await stale)["payments.stripe.live"]).toBe(false); // read before the write
    expect(
      (
        await readFlags(
          () => d1,
          () => 1,
        )
      )["payments.stripe.live"],
    ).toBe(true);
  });

  test("a held read is never joined or returned past FLAG_CACHE_MS (Codex P2)", async () => {
    // Isolate B starts a read at t=0 that sees ON, and D1 holds the answer;
    // the owner turns it OFF; a checkout at t=40 s must not join that read.
    const d1 = createTestD1(testSchema());
    await setFlag(d1, "payments.stripe.live", true, BY, NOW);
    clearFlagCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = true;
    const slow: D1Like = {
      prepare: (q) => {
        const stmt = d1.prepare(q);
        return {
          ...stmt,
          bind: stmt.bind.bind(stmt),
          first: stmt.first.bind(stmt),
          run: stmt.run.bind(stmt),
          all: async <T>() => {
            const r = await stmt.all<T>();
            if (held) await gate;
            return r;
          },
        };
      },
      exec: (q) => d1.exec(q),
    };
    let t = 0;
    const now = () => t;
    const errors: string[] = [];
    const realError = console.error;
    console.error = (m: string) => void errors.push(m);
    try {
      const first = readFlags(() => slow, now); // t=0, held
      // The flip happens in another isolate: straight to D1, this cache untouched.
      d1.raw()
        .prepare("UPDATE feature_flags SET enabled = 0 WHERE key = ?")
        .run("payments.stripe.live");
      t = FLAG_CACHE_MS + 10_000; // t=40 s: a new checkout
      held = false;
      const late = readFlags(() => slow, now);
      release(); // the old answer (ON) arrives at t=41 s
      t += 1_000;
      expect((await late)["payments.stripe.live"]).toBe(false); // its own fresh read
      expect((await first)["payments.stripe.live"]).toBe(false); // too old to act on: off
    } finally {
      console.error = realError;
    }
    expect(errors.some((e) => e.includes("flags.read-stale"))).toBe(true);
  });

  test("off the D1 backend every flag is off, without touching a database", async () => {
    process.env.DB_BACKEND = "mongodb";
    expect(await readFlags()).toEqual(closedFlags());
    expect(await flagOn("payments.stripe.live")).toBe(false);
  });
});

describe("sameOriginJsonPost (CSRF)", () => {
  const req = (headers: Record<string, string>, method = "POST", url = "https://lianki.com/x") =>
    new Request(url, { method, headers, body: method === "POST" ? "{}" : undefined });
  const ok = {
    "content-type": "application/json",
    origin: "https://lianki.com",
    host: "lianki.com",
    "sec-fetch-site": "same-origin",
  };

  test("a same-origin JSON fetch passes", () => {
    expect(sameOriginJsonPost(req(ok))).toBe(true);
    expect(
      sameOriginJsonPost(req({ ...ok, "content-type": "application/json; charset=utf-8" })),
    ).toBe(true);
    const { "sec-fetch-site": _, ...noSite } = ok;
    expect(sameOriginJsonPost(req(noSite))).toBe(true); // older browsers omit it
    // No Host header: the request URL's host.
    const { host: _h, ...noHost } = ok;
    expect(sameOriginJsonPost(req(noHost))).toBe(true);
    expect(
      sameOriginJsonPost(
        req(
          { ...ok, origin: "http://localhost:3000", host: "localhost:3000" },
          "POST",
          "http://localhost:3000/x",
        ),
      ),
    ).toBe(true);
  });

  test("anything a cross-site page could send is refused", () => {
    const { origin: _, ...noOrigin } = ok;
    for (const h of [
      noOrigin,
      { ...ok, origin: "https://evil.example" },
      { ...ok, origin: "https://lianki.com.evil.example" },
      { ...ok, origin: "null" },
      { ...ok, origin: "http://lianki.com" }, // plain http off localhost
      { ...ok, origin: "javascript:alert(1)" },
      { ...ok, "sec-fetch-site": "cross-site" },
      { ...ok, "sec-fetch-site": "same-site" },
      { ...ok, "content-type": "text/plain" },
      { ...ok, "content-type": "application/x-www-form-urlencoded" },
      { ...ok, "content-type": "multipart/form-data; boundary=x" },
    ])
      expect(sameOriginJsonPost(req(h as Record<string, string>))).toBe(false);
    expect(sameOriginJsonPost(req(ok, "GET"))).toBe(false);
  });
});
