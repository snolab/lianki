import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { createBudgetRecorder } from "../workers/monitor/src/budget";
const log = spyOn(console, "log").mockImplementation(() => {});
afterAll(() => log.mockRestore());
const MINUTE = 60000;
const START = Date.parse("2026-11-25T12:00:00Z");
function setup(values: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  const writes: { key: string; value: string }[] = [];
  const calls: string[] = [];
  const env = {
    SLACK_CHANNEL: "test-channel",
    STATE: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
        writes.push({ key, value });
      },
    },
    SESSIONS: {
      config: async (key: string) => {
        calls.push(key);
        return values[key];
      },
    },
  };
  return { env, store, writes, calls };
}
describe("event driven request and CPU budgets", () => {
  test("successful requests count, thresholds are strict and alert is de-duplicated", async () => {
    const { env, store, calls } = setup({ "monitor.pathRateMax": 2 });
    const record = createBudgetRecorder();
    await record(env, "/api/prefs", 200, 0, START);
    await record(env, "/api/prefs", 200, 0, START + 1);
    expect(store.has("alerted:path-rate:/api/prefs")).toBe(false);
    await record(env, "/api/prefs", 200, 0, START + 2);
    await record(env, "/api/prefs", 200, 0, START + 3);
    expect(store.has("alerted:path-rate:/api/prefs")).toBe(true);
    expect(calls).toHaveLength(3);
  });
  test("401 has its own hour window; a ten-minute gap clears rate but not refusal", async () => {
    const { env, store } = setup({ "monitor.pathRateMax": 1, "monitor.repeat401Max": 1 });
    const record = createBudgetRecorder();
    await record(env, "/api/fsrs/watch", 401, 0, START);
    const result = await record(env, "/api/fsrs/watch", 401, 0, START + 10 * MINUTE);
    expect(result.rate).toBe(1);
    expect(result.refused).toBe(2);
    expect(store.has("alerted:path-rate:/api/fsrs/watch")).toBe(false);
    expect(store.has("alerted:repeat-401:/api/fsrs/watch")).toBe(true);
    expect((await record(env, "/api/fsrs/watch", 200, 0, START + 70 * MINUTE)).refused).toBe(0);
  });
  test("path cardinality and each hour's minute bins stay bounded", async () => {
    const { env } = setup();
    const record = createBudgetRecorder();
    for (let i = 0; i < 200; i++)
      expect((await record(env, `/path-${i}`, 200, 0, START)).paths).toBeLessThanOrEqual(128);
    for (let i = 0; i < 120; i++)
      expect((await record(env, "/stable", 200, 0, START + i * MINUTE)).bins).toBeLessThanOrEqual(
        60,
      );
  });
  test("CPU uses CPU only, flushes at most once a minute, and resumes its UTC day", async () => {
    const { env, store, writes } = setup();
    store.set("cpu:2026-11-25", "100");
    const record = createBudgetRecorder();
    await record(env, "/", 200, 2, START);
    await record(env, "/", 200, 3, START + 1);
    expect(writes.filter((w) => w.key.startsWith("cpu:"))).toHaveLength(0);
    const result = await record(env, "/", 200, 4, START + MINUTE);
    expect(result.cpuMs).toBe(109);
    expect(writes.filter((w) => w.key.startsWith("cpu:"))).toHaveLength(1);
    await record(env, "/", 200, -1, START + MINUTE + 1);
    expect((await record(env, "/", 200, NaN, START + MINUTE + 2)).cpuMs).toBe(109);
    expect((await record(env, "/", 200, 1, Date.parse("2026-11-26T00:00:00Z"))).cpuMs).toBe(1);
  });
  test("CPU monthly projection respects the live threshold and does not write per request", async () => {
    const { env, store, writes } = setup({ "monitor.cpuMsMonthAlert": 100 });
    const record = createBudgetRecorder();
    const result = await record(env, "/", 200, 100, START);
    expect(result.projected).toBe(6000);
    expect(store.has("alerted:cpu-budget")).toBe(true);
    await record(env, "/", 200, 100, START + 1);
    expect(writes.filter((w) => w.key === "alerted:cpu-budget")).toHaveLength(1);
    expect(writes.filter((w) => w.key.startsWith("cpu:"))).toHaveLength(0);
  });
  test("config failures and invalid values use defaults; later events refresh config", async () => {
    const { env, calls, store } = setup({
      "monitor.pathRateMax": 0,
      "monitor.repeat401Max": "1",
      "monitor.cpuMsMonthAlert": NaN,
    });
    const record = createBudgetRecorder();
    store.set("cpu:2026-11-25", "malformed");
    expect((await record(env, "/", 401, 0, START)).cpuMs).toBe(0);
    expect(store.size).toBe(1);
    env.SESSIONS.config = async (key) => {
      calls.push(key);
      throw new Error("private service failure");
    };
    await record(env, "/", 401, 0, START + 10 * MINUTE);
    expect(calls).toHaveLength(6);
  });
  test("concurrent events keep in-isolate CPU increments and bounded alert cache", async () => {
    const { env, store } = setup({ "monitor.pathRateMax": 1, "monitor.repeat401Max": 1 });
    const record = createBudgetRecorder();
    await Promise.all(Array.from({ length: 10 }, () => record(env, "/", 200, 1, START)));
    expect((await record(env, "/", 200, 0, START)).cpuMs).toBe(10);
    for (let i = 0; i < 130; i++) {
      await record(env, `/other-${i}`, 401, 0, START);
      await record(env, `/other-${i}`, 401, 0, START);
    }
    store.clear();
    await record(env, "/new", 200, 0, START + 31 * MINUTE);
  });
});
