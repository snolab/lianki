import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { configLive } from "@/lib/debug-session";
import {
  CONFIG,
  CONFIG_KEYS,
  defaultConfig,
  isConfigKey,
  parseConfigValue,
  parseStoredConfig,
  PUBLIC_CONFIG_KEYS,
  publicSubset,
  resolveConfig,
  type ConfigDef,
} from "@/lib/config";
import {
  cfg,
  changeConfig,
  clearConfigCache,
  CONFIG_CACHE_MS,
  ConfigError,
  configLog,
  listConfig,
  loadConfig,
  publicConfig,
  readConfig,
  resetConfig,
  setConfig,
} from "@/lib/config-store";
import { publicCfg, setPublicConfig } from "@/lib/config-client";
import { snapshotCache } from "@/lib/snapshot-cache";
import {
  draftValue,
  fill,
  formatValue,
  groupConfigRows,
  historyOf,
  sameValue,
} from "@/app/(app)/dev/config/config-view";
import { createDeferredDelete, undoMs } from "@/lib/words/deferred-delete";
import { startWpm } from "@/lib/read/reader-adapter";
import { HUMAN_REACTION_MS, qualifies } from "@/lib/study-days";

/**
 * The config store (docs/config-store.md). What matters: only registry keys
 * exist; a value that fails its schema never takes effect (the default does);
 * an unreadable store reads as the defaults; a change reaches requests within
 * the cache window with no deploy; every change is logged with who, when, why
 * and the old value; money keys need an explicit confirmation; only public keys
 * reach the browser.
 */
const NOW = new Date("2026-11-10T07:00:00.000Z");
const BY = "owner@x.com";

beforeEach(() => clearConfigCache());
afterEach(() => {
  clearConfigCache();
  setPublicConfig(null);
});

describe("registry", () => {
  test("every key has a valid default inside its range, a description and a group", () => {
    expect(CONFIG_KEYS.length).toBeGreaterThanOrEqual(5);
    for (const k of CONFIG_KEYS) {
      const d = CONFIG[k] as ConfigDef;
      expect(parseConfigValue(k, d.default) as unknown).toEqual({ ok: true, value: d.default });
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.group.length).toBeGreaterThan(0);
      if (typeof d.default === "number") {
        expect(d.min).toBeLessThanOrEqual(d.default);
        expect(d.max).toBeGreaterThanOrEqual(d.default);
        expect(parseConfigValue(k, d.min! - 1).ok).toBe(false);
        expect(parseConfigValue(k, d.max! + 1).ok).toBe(false);
      }
    }
    expect(defaultConfig()["words.undoMs"]).toBe(8000);
  });

  test("only registry keys are keys", () => {
    expect(isConfigKey("words.undoMs")).toBe(true);
    for (const k of ["nope", "", "toString", "__proto__", 1, null, undefined])
      expect(isConfigKey(k)).toBe(false);
  });

  test("values are checked: type, whole numbers, bounds", () => {
    expect(parseConfigValue("words.undoMs", 9000)).toEqual({ ok: true, value: 9000 });
    expect(parseConfigValue("words.undoMs", "9000").ok).toBe(false);
    expect(parseConfigValue("words.undoMs", 9000.5).ok).toBe(false);
    expect(parseConfigValue("words.undoMs", null).ok).toBe(false);
    const bad = parseConfigValue("words.undoMs", 1);
    expect(bad.ok === false && bad.error.length > 0).toBe(true);
  });

  test("a stored JSON text reads only when it parses and validates", () => {
    expect(parseStoredConfig("words.undoMs", "9000")).toBe(9000);
    expect(parseStoredConfig("words.undoMs", "{")).toBeUndefined();
    expect(parseStoredConfig("words.undoMs", '"9000"')).toBeUndefined();
    expect(parseStoredConfig("words.undoMs", "1")).toBeUndefined();
    expect(parseStoredConfig("words.undoMs", null)).toBeUndefined();
  });

  test("read order: default → global → the user's own, only where a key allows it", () => {
    expect(resolveConfig("words.undoMs", 9000)).toBe(9000);
    expect(resolveConfig("words.undoMs", 9000, 12000)).toBe(9000); // no userPref
    const d = CONFIG["read.startWpm"] as ConfigDef;
    d.userPref = true;
    try {
      expect(resolveConfig("read.startWpm", 150, 200)).toBe(200);
      expect(resolveConfig("read.startWpm", 150, 5)).toBe(150); // invalid: the global stays
      expect(resolveConfig("read.startWpm", 150, undefined)).toBe(150);
    } finally {
      delete d.userPref;
    }
  });

  test("only public keys go to the browser", () => {
    expect(PUBLIC_CONFIG_KEYS).toContain("words.undoMs");
    expect(PUBLIC_CONFIG_KEYS).not.toContain("study.humanReactionMs" as never);
    const sub = publicSubset(defaultConfig());
    expect(Object.keys(sub).sort()).toEqual([...PUBLIC_CONFIG_KEYS].sort());
  });
});

describe("store", () => {
  let d1: ReturnType<typeof createTestD1>;
  beforeEach(() => {
    d1 = createTestD1(testSchema());
  });

  test("a fresh database reads every key at its default", async () => {
    expect(await loadConfig(d1)).toEqual(defaultConfig());
    const rows = await listConfig(d1);
    expect(rows.map((r) => r.key)).toEqual(CONFIG_KEYS);
    for (const r of rows)
      expect(r).toMatchObject({ stored: false, invalid: false, value: r.default });
    expect(await configLog(d1)).toEqual([]);
  });

  test("setConfig writes the row and a log entry with the old value, who, when and why", async () => {
    const row = await setConfig(d1, "words.undoMs", 9000, BY, { now: NOW, note: "longer" });
    expect(row).toMatchObject({ key: "words.undoMs", value: 9000, stored: true, updatedBy: BY });
    expect((await loadConfig(d1))["words.undoMs"]).toBe(9000);
    await setConfig(d1, "words.undoMs", 10000, "b@x.com", { now: new Date(NOW.getTime() + 1000) });
    const log = await configLog(d1);
    expect(log).toEqual([
      {
        key: "words.undoMs",
        old: 9000,
        new: 10000,
        by: "b@x.com",
        at: "2026-11-10T07:00:01.000Z",
        note: null,
      },
      { key: "words.undoMs", old: null, new: 9000, by: BY, at: NOW.toISOString(), note: "longer" },
    ]);
    expect(await configLog(d1, 1, "words.undoMs")).toHaveLength(1);
    expect(await configLog(d1, 10, "read.startWpm")).toEqual([]);
    const listed = (await listConfig(d1)).find((r) => r.key === "words.undoMs");
    expect(listed).toMatchObject({ value: 10000, stored: true, updatedBy: "b@x.com" });
  });

  test("reset removes the row and logs new = null", async () => {
    await setConfig(d1, "read.startWpm", 200, BY, { now: NOW });
    const row = await resetConfig(d1, "read.startWpm", BY, { now: NOW });
    expect(row).toMatchObject({ value: 120, stored: false });
    expect((await loadConfig(d1))["read.startWpm"]).toBe(120);
    expect((await configLog(d1))[0]).toMatchObject({ old: 200, new: null });
  });

  test("unknown keys, invalid values, a missing author and a long note are refused before D1", async () => {
    await expect(setConfig(d1, "nope", 1, BY)).rejects.toThrow(ConfigError);
    await expect(setConfig(d1, "words.undoMs", 1, BY)).rejects.toThrow(ConfigError);
    await expect(setConfig(d1, "words.undoMs", 9000, " ")).rejects.toThrow(ConfigError);
    await expect(
      setConfig(d1, "words.undoMs", 9000, BY, { note: "x".repeat(501) }),
    ).rejects.toThrow(ConfigError);
    await expect(resetConfig(d1, "nope", BY)).rejects.toThrow(ConfigError);
    expect(await configLog(d1)).toEqual([]);
  });

  test("a stored value that fails its schema, or an unknown key's row, reads as the default", async () => {
    const at = NOW.toISOString();
    for (const [k, v] of [
      ["words.undoMs", "1"],
      ["read.startWpm", "not json"],
      ["gone.key", "5"],
    ])
      await d1
        .prepare(
          "INSERT INTO config_values (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)",
        )
        .bind(k, v, at, BY)
        .run();
    expect(await loadConfig(d1)).toEqual(defaultConfig());
    const row = (await listConfig(d1)).find((r) => r.key === "words.undoMs");
    expect(row).toMatchObject({ value: 8000, stored: false, invalid: true });
  });

  test("a log row with a non-JSON text reads as that text", async () => {
    await d1
      .prepare("INSERT INTO config_log (key, old_json, new_json, by, at) VALUES (?, ?, ?, ?, ?)")
      .bind("words.undoMs", "oops", "9000", BY, NOW.toISOString())
      .run();
    expect((await configLog(d1))[0]).toMatchObject({ old: "oops", new: 9000 });
  });

  test("a money key needs confirmMoney", async () => {
    const cfgAny = CONFIG as unknown as Record<string, ConfigDef>;
    cfgAny["test.money"] = {
      default: 100,
      schema: z.number().int().min(0).max(1000),
      description: "a test price, not real",
      group: "test",
      audience: "server",
      money: true,
    };
    try {
      await expect(setConfig(d1, "test.money", 200, BY)).rejects.toThrow(/confirmMoney/);
      const r = await setConfig(d1, "test.money", 200, BY, { confirmMoney: true });
      expect(r.value).toBe(200);
      expect(await changeConfig(d1, { key: "test.money", reset: true }, BY)).toMatchObject({
        ok: false,
      });
      expect(
        await changeConfig(d1, { key: "test.money", reset: true, confirmMoney: true }, BY),
      ).toMatchObject({ ok: true, row: { value: 100 } });
    } finally {
      delete cfgAny["test.money"];
    }
  });

  test("changeConfig: the editor's body to a set or a reset, errors as text", async () => {
    expect(
      await changeConfig(d1, { key: "words.undoMs", value: 12000, note: "n" }, BY),
    ).toMatchObject({
      ok: true,
      row: { value: 12000 },
    });
    expect(await changeConfig(d1, { key: "words.undoMs", reset: true }, BY)).toMatchObject({
      ok: true,
      row: { stored: false },
    });
    expect(await changeConfig(d1, { key: "words.undoMs", value: "x" }, BY)).toMatchObject({
      ok: false,
    });
    expect(await changeConfig(d1, null, BY)).toEqual({ ok: false, error: "Unknown key" });
    const broken = {
      prepare: () => {
        throw new Error("d1 down");
      },
    } as unknown as Parameters<typeof changeConfig>[0];
    await expect(changeConfig(broken, { key: "words.undoMs", value: 9000 }, BY)).rejects.toThrow(
      "d1 down",
    );
  });
});

describe("read path: cache, fail to defaults", () => {
  test("cached for the window; a write here clears it; a change elsewhere shows after the window", async () => {
    const d1 = createTestD1(testSchema());
    let t = 1_000_000;
    const now = () => t;
    const db = () => d1 as unknown as D1Like;
    expect((await readConfig(db, now))["words.undoMs"]).toBe(8000);
    // Written behind the cache's back (another isolate): not seen until the window passes.
    await d1
      .prepare(
        "INSERT INTO config_values (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)",
      )
      .bind("words.undoMs", "9000", NOW.toISOString(), BY)
      .run();
    expect((await readConfig(db, now))["words.undoMs"]).toBe(8000);
    t += CONFIG_CACHE_MS;
    expect((await readConfig(db, now))["words.undoMs"]).toBe(9000);
    // A write here is seen at once.
    await setConfig(d1, "words.undoMs", 11000, BY);
    expect((await readConfig(db, now))["words.undoMs"]).toBe(11000);
  });

  test("no D1, or a failing read: the defaults, and nothing cached", async () => {
    expect(await readConfig(() => null)).toEqual(defaultConfig());
    const failing = {
      prepare: () => {
        throw new Error("boom");
      },
    } as unknown as D1Like;
    expect(await readConfig(() => failing)).toEqual(defaultConfig());
    const d1 = createTestD1(testSchema());
    await setConfig(d1, "words.undoMs", 9000, BY);
    expect((await readConfig(() => d1 as unknown as D1Like))["words.undoMs"]).toBe(9000);
  });

  test("cfg and publicConfig off D1 read the defaults", async () => {
    expect(await cfg("study.humanReactionMs")).toBe(1000);
    const pub = await publicConfig();
    expect(pub["words.undoMs"]).toBe(8000);
    expect("study.humanReactionMs" in pub).toBe(false);
  });

  test("concurrent reads share one query; a held read past the window falls back", async () => {
    const cache = snapshotCache<{ n: number }>({
      slot: "__lkTestSnapshot",
      ttlMs: 100,
      fallback: () => ({ n: -1 }),
      copy: (v) => ({ ...v }),
      event: "test",
    });
    cache.clear();
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let t = 0;
    const load = async () => {
      loads++;
      await gate;
      return { n: loads };
    };
    const a = cache.read(load, () => t);
    const b = cache.read(load, () => t);
    release();
    expect(await a).toEqual({ n: 1 });
    expect(await b).toEqual({ n: 1 });
    expect(loads).toBe(1);

    // A read whose answer arrives after the window is not used.
    cache.clear();
    let slowRelease!: () => void;
    const slowGate = new Promise<void>((r) => (slowRelease = r));
    const slow = cache.read(
      async () => {
        await slowGate;
        return { n: 99 };
      },
      () => t,
    );
    t += 200;
    slowRelease();
    expect(await slow).toEqual({ n: -1 });

    // A clear during a read keeps that read out of the cache.
    t = 1000;
    let r3!: () => void;
    const g3 = new Promise<void>((r) => (r3 = r));
    const during = cache.read(
      async () => {
        await g3;
        return { n: 3 };
      },
      () => t,
    );
    cache.clear();
    r3();
    expect(await during).toEqual({ n: 3 });
    expect(
      await cache.read(
        async () => ({ n: 4 }),
        () => t,
      ),
    ).toEqual({ n: 4 });
  });
});

describe("client: public values", () => {
  test("defaults until the server's values arrive; invalid or non-public values are dropped", () => {
    expect(publicCfg("words.undoMs")).toBe(8000);
    setPublicConfig({ "words.undoMs": 12000, "read.startWpm": 5 } as never);
    expect(publicCfg("words.undoMs")).toBe(12000);
    expect(publicCfg("read.startWpm")).toBe(120);
    setPublicConfig({ "study.humanReactionMs": 3000, nope: 1 } as never);
    expect(publicCfg("words.undoMs")).toBe(8000);
  });

  test("the migrated callers read the live value", () => {
    setPublicConfig({ "words.undoMs": 10000, "files.undoMs": 7000, "read.startWpm": 200 });
    expect(undoMs()).toBe(10000);
    expect(startWpm()).toBe(200);
    let delay = 0;
    const d = createDeferredDelete<string>({
      commit: () => {},
      onChange: () => {},
      setTimer: (_fn, ms) => {
        delay = ms;
        return 1;
      },
      clearTimer: () => {},
    });
    d.remove("x");
    expect(delay).toBe(10000);
  });

  test("study days take the threshold the route passes", () => {
    expect(HUMAN_REACTION_MS).toBe(1000);
    expect(qualifies(1500)).toBe(true);
    expect(qualifies(1500, 2000)).toBe(false);
  });
});

describe("/dev/config view", () => {
  test("rows grouped in registry order, changed counted", () => {
    const rows = CONFIG_KEYS.map((key) => ({
      key,
      value: key === "words.undoMs" ? 9000 : CONFIG[key].default,
      default: CONFIG[key].default,
      stored: key === "words.undoMs",
      invalid: false,
      updatedAt: null,
      updatedBy: null,
    }));
    const groups = groupConfigRows(rows);
    expect(groups[0]).toMatchObject({ id: "words", changed: 1 });
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(rows.length);
    expect(groups.find((g) => g.id === "read")?.changed).toBe(0);
  });

  test("formatting, drafts, history, placeholders", () => {
    expect(formatValue(8000, "ms")).toBe("8000 ms");
    expect(formatValue("hi", undefined)).toBe("hi");
    expect(formatValue(null, "ms", "默认")).toBe("默认");
    expect(formatValue(undefined, "ms")).toBe("default");
    expect(draftValue("words.undoMs", " 9000 ")).toBe(9000);
    expect(draftValue("words.undoMs", "")).toBeNaN();
    const cfgAny = CONFIG as unknown as Record<string, ConfigDef>;
    cfgAny["test.text"] = {
      default: "hi",
      schema: z.string(),
      description: "a test text value",
      group: "test",
      audience: "public",
    };
    try {
      expect(draftValue("test.text" as never, " x ")).toBe(" x ");
    } finally {
      delete cfgAny["test.text"];
    }
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue(1, 2)).toBe(false);
    const log = [
      { key: "a", old: null, new: 1, by: BY, at: "", note: null },
      { key: "b", old: null, new: 1, by: BY, at: "", note: null },
    ];
    expect(historyOf(log, "a")).toHaveLength(1);
    expect(fill("{a} {b} {c}", { a: 1, b: "x" })).toBe("1 x {c}");
  });
});

describe("configLive: a config value for a hub without D1 (DebugSessions.config)", () => {
  const db = (rows: { value_json: string }[]) => ({
    prepare: () => ({ bind: () => ({ all: async <T>() => ({ results: rows as T[] }) }) }),
  });
  test("a valid row, else the default; an unknown key is undefined", async () => {
    const key = "chat.ownerWaitRemindDays";
    expect(await configLive(db([{ value_json: '"2,4"' }]), key)).toBe("2,4");
    expect(await configLive(db([{ value_json: '"0"' }]), key)).toBe("1,3,7");
    expect(await configLive(db([]), key)).toBe("1,3,7");
    expect(await configLive(null, key)).toBe("1,3,7");
    expect(await configLive(db([]), "nope")).toBeUndefined();
  });
});
