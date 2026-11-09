import { describe, expect, test } from "bun:test";
import {
  DEFAULT_S,
  median,
  parseShard,
  shardSeconds,
  splitSuites,
  timingsFromLog,
} from "../scripts/qa/shard.mjs";
import { SUITES } from "../scripts/qa/suites.mjs";
import timingsFile from "../scripts/qa/suite-timings.json";

const T: Record<string, number> = timingsFile.seconds;
type S = { id: string; everyShard?: boolean };
const s = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

describe("parseShard", () => {
  test("i/n", () => {
    expect(parseShard("2/3")).toEqual({ index: 2, count: 3 });
    expect(parseShard("1/1")).toEqual({ index: 1, count: 1 });
  });
  test("rejects out of range and junk", () => {
    for (const bad of ["0/3", "4/3", "1/0", "x", "", undefined, "1/3/2"])
      expect(parseShard(bad)).toBeNull();
  });
});

describe("splitSuites", () => {
  test("longest first onto the lightest shard, list order kept inside", () => {
    const list = [s("a"), s("b"), s("c"), s("d")];
    const t = { a: 10, b: 100, c: 60, d: 50 };
    const [one, two] = splitSuites(list, 2, t);
    // b → 1 (100), c → 2 (60), d → 2 (110), a → 1 (110).
    expect(one.map((x: S) => x.id)).toEqual(["a", "b"]);
    expect(two.map((x: S) => x.id)).toEqual(["c", "d"]);
  });

  test("an everyShard suite starts every shard and is not counted", () => {
    const list = [s("first", { everyShard: true }), s("x"), s("y")];
    const shards = splitSuites(list, 2, { first: 7, x: 5, y: 5 });
    for (const sh of shards) expect(sh[0].id).toBe("first");
    expect(shards.map((sh: S[]) => sh.length)).toEqual([2, 2]);
  });

  test("unknown suites count as the default", () => {
    expect(shardSeconds([s("nope")], {})).toBe(DEFAULT_S);
  });

  test("the real list: every suite in exactly one shard (or all), within 20% of each other", () => {
    const shards = splitSuites(SUITES, 3, T);
    for (const suite of SUITES) {
      const n = shards.filter((sh: S[]) => sh.includes(suite)).length;
      expect(n).toBe(suite.everyShard ? 3 : 1);
    }
    const secs = shards.map((sh: S[]) => shardSeconds(sh, T));
    expect(Math.max(...secs) / Math.min(...secs)).toBeLessThan(1.2);
  });

  test("every suite has a recorded time", () => {
    for (const suite of SUITES) expect(typeof T[suite.id]).toBe("number");
  });
});

describe("record-timings", () => {
  test("reads the per-suite lines and takes medians", () => {
    const log = "x\tqa:all timing words 120.5\ny\tqa:all timing api 3.0\n";
    expect(timingsFromLog(log)).toEqual({ words: 120.5, api: 3 });
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
