import { describe, expect, test, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  COV_BUCKET_S,
  COV_MAX_BUCKETS,
  MAX_DEVICES,
  coverageBuckets,
  coverageCount,
  decodeCoverage,
  emptyDeviceWatch,
  emptyWatchStats,
  encodeCoverage,
  localDayKey,
  markCoverage,
  mergeCoverage,
  mergeWatchStats,
  newCoverage,
  parseWatchStats,
  sanitizeWatchStats,
  summarizeWatch,
  type DeviceWatch,
  type WatchStats,
} from "@lianki/core";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import type { D1Like } from "@/lib/d1/types";
import { WatchStatsD1Repo, currentStreak } from "@/lib/repos/watchStatsD1";

const dev = (over: Partial<DeviceWatch> = {}): DeviceWatch => ({ ...emptyDeviceWatch(), ...over });
const stats = (by: Record<string, DeviceWatch>): WatchStats => ({ v: 1, by });

// ── Coverage bitset ──────────────────────────────────────────────────────────

describe("coverage bitset", () => {
  test("marks every bucket an interval touches, and no others", () => {
    const bytes = newCoverage(coverageBuckets(100)); // 20 buckets at 5 s
    markCoverage(bytes, 10, 24); // buckets 2,3,4
    expect(coverageCount(bytes)).toBe(3);
    markCoverage(bytes, 10, 24); // idempotent — bits only ever turn on
    expect(coverageCount(bytes)).toBe(3);
  });

  test("clamps out-of-range intervals instead of throwing", () => {
    const bytes = newCoverage(coverageBuckets(100));
    markCoverage(bytes, -50, 3);
    expect(coverageCount(bytes)).toBe(1);
    markCoverage(bytes, 1e6, 1e7);
    markCoverage(bytes, NaN, 5);
    expect(coverageCount(bytes)).toBeLessThanOrEqual(bytes.length * 8);
  });

  test("accepts a reversed interval", () => {
    const bytes = newCoverage(coverageBuckets(100));
    markCoverage(bytes, 24, 10);
    expect(coverageCount(bytes)).toBe(3);
  });

  test("no-ops on a zero-length bitset", () => {
    const bytes = newCoverage(0);
    markCoverage(bytes, 0, 100);
    expect(coverageCount(bytes)).toBe(0);
  });

  test("base64 round-trips, including a bitset larger than one chunk", () => {
    const bytes = newCoverage(COV_MAX_BUCKETS);
    for (let i = 0; i < COV_MAX_BUCKETS; i += 7)
      markCoverage(bytes, i * COV_BUCKET_S, i * COV_BUCKET_S);
    const back = decodeCoverage(encodeCoverage(bytes));
    expect([...back]).toEqual([...bytes]);
  });

  test("decode tolerates garbage", () => {
    expect(decodeCoverage(undefined).length).toBe(0);
    expect(decodeCoverage("!!!not base64!!!").length).toBe(0);
  });

  test("buckets are skipped for unknown, zero, or over-long duration", () => {
    expect(coverageBuckets(undefined)).toBe(0);
    expect(coverageBuckets(0)).toBe(0);
    expect(coverageBuckets(NaN)).toBe(0);
    expect(coverageBuckets(Infinity)).toBe(0);
    expect(coverageBuckets(COV_MAX_BUCKETS * COV_BUCKET_S + 1)).toBe(0);
    expect(coverageBuckets(600)).toBe(120);
  });

  test("merge ORs bitsets of differing length", () => {
    const a = newCoverage(16);
    markCoverage(a, 0, 0);
    const b = newCoverage(64);
    markCoverage(b, 40 * COV_BUCKET_S, 40 * COV_BUCKET_S);
    const merged = decodeCoverage(mergeCoverage(encodeCoverage(a), encodeCoverage(b)));
    expect(coverageCount(merged)).toBe(2);
    expect(mergeCoverage(undefined, "AA==")).toBe("AA==");
    expect(mergeCoverage("AA==", undefined)).toBe("AA==");
    expect(mergeCoverage(undefined, undefined)).toBeUndefined();
  });
});

// ── Merge ────────────────────────────────────────────────────────────────────

describe("mergeWatchStats", () => {
  const T1 = "2026-07-27T09:00:00.000Z";
  const T2 = "2026-07-27T21:00:00.000Z";
  const T3 = "2026-07-28T08:00:00.000Z";
  const a = stats({
    d1: dev({
      wall: 100,
      media: 150,
      sessions: 2,
      days: { "2026-07-27": 100 },
      first: T2,
      last: T2,
    }),
  });
  const b = stats({
    d1: dev({ wall: 60, media: 90, sessions: 1, days: { "2026-07-28": 60 }, first: T1, last: T3 }),
    d2: dev({ wall: 30, media: 30, sessions: 1, days: { "2026-07-28": 30 } }),
  });

  test("is idempotent — replaying a payload cannot double-count", () => {
    const once = mergeWatchStats(a, b);
    const twice = mergeWatchStats(once, b);
    expect(twice).toEqual(once);
    expect(summarizeWatch(twice).wall).toBe(summarizeWatch(once).wall);
  });

  test("is commutative", () => {
    expect(mergeWatchStats(a, b)).toEqual(mergeWatchStats(b, a));
  });

  test("is associative", () => {
    const c = stats({ d3: dev({ wall: 5, media: 5, sessions: 1, days: {} }) });
    expect(mergeWatchStats(mergeWatchStats(a, b), c)).toEqual(
      mergeWatchStats(a, mergeWatchStats(b, c)),
    );
  });

  test("keeps the per-device max, never the sum — a device's counter is grow-only", () => {
    const m = mergeWatchStats(a, b).by.d1;
    expect(m.wall).toBe(100);
    expect(m.media).toBe(150);
    expect(m.sessions).toBe(2);
    expect(m.days).toEqual({ "2026-07-27": 100, "2026-07-28": 60 });
    expect(m.first).toBe(T1); // earliest
    expect(m.last).toBe(T3); // latest
  });

  test("a device seen on only one side survives", () => {
    expect(mergeWatchStats(a, b).by.d2.wall).toBe(30);
  });

  test("tolerates null/undefined operands", () => {
    expect(mergeWatchStats(null, null)).toEqual(emptyWatchStats());
    expect(mergeWatchStats(a, undefined)).toEqual(a);
    expect(mergeWatchStats(undefined, a)).toEqual(a);
  });

  test("language follows the more recent observation, order-independently", () => {
    const ja = stats({ d: dev({ lang: "ja", last: "2026-07-28T00:00:00Z" }) });
    const en = stats({ d: dev({ lang: "en", last: "2026-07-27T00:00:00Z" }) });
    expect(mergeWatchStats(ja, en).by.d.lang).toBe("ja");
    expect(mergeWatchStats(en, ja).by.d.lang).toBe("ja");
  });

  test("equal timestamps break ties deterministically", () => {
    const x = stats({ d: dev({ lang: "ja", last: "T" }) });
    const y = stats({ d: dev({ lang: "en", last: "T" }) });
    expect(mergeWatchStats(x, y).by.d.lang).toBe(mergeWatchStats(y, x).by.d.lang);
  });

  test("a language present on one side only is adopted", () => {
    const withLang = stats({ d: dev({ lang: "ko" }) });
    expect(mergeWatchStats(withLang, stats({ d: dev() })).by.d.lang).toBe("ko");
    expect(mergeWatchStats(stats({ d: dev() }), withLang).by.d.lang).toBe("ko");
  });
});

// ── Summary ──────────────────────────────────────────────────────────────────

describe("summarizeWatch", () => {
  test("sums across devices — each device's counter is its own", () => {
    const s = summarizeWatch(
      stats({
        laptop: dev({ wall: 100, media: 120, sessions: 2, days: { "2026-07-28": 100 } }),
        phone: dev({
          wall: 50,
          media: 60,
          sessions: 1,
          days: { "2026-07-28": 50, "2026-07-27": 10 },
        }),
      }),
    );
    expect(s.wall).toBe(150);
    expect(s.media).toBe(180);
    expect(s.sessions).toBe(3);
    expect(s.devices).toBe(2);
    expect(s.days).toEqual({ "2026-07-28": 150, "2026-07-27": 10 });
  });

  test("coverage is the union across devices, as a 0..1 ratio", () => {
    const dur = 100; // 20 buckets
    const first = newCoverage(coverageBuckets(dur));
    markCoverage(first, 0, 24); // buckets 0-4
    const second = newCoverage(coverageBuckets(dur));
    markCoverage(second, 50, 74); // buckets 10-14
    const s = summarizeWatch(
      stats({
        a: dev({ dur, cov: encodeCoverage(first) }),
        b: dev({ dur, cov: encodeCoverage(second) }),
      }),
    );
    expect(s.coverage).toBeCloseTo(10 / 20, 5);
    expect(s.dur).toBe(dur);
  });

  test("coverage is undefined when there is nothing to divide by", () => {
    expect(summarizeWatch(stats({ a: dev({ wall: 10 }) })).coverage).toBeUndefined();
    expect(summarizeWatch(null).coverage).toBeUndefined();
    expect(summarizeWatch(null).wall).toBe(0);
  });

  test("reports the most recently observed language", () => {
    const s = summarizeWatch(
      stats({
        old: dev({ lang: "en", first: "2026-01-01T00:00:00Z", last: "2026-01-01T00:00:00Z" }),
        recent: dev({ lang: "ja", first: "2026-07-01T00:00:00Z", last: "2026-07-28T00:00:00Z" }),
      }),
    );
    expect(s.lang).toBe("ja");
    expect(s.first).toBe("2026-01-01T00:00:00Z");
    expect(s.last).toBe("2026-07-28T00:00:00Z");
  });
});

// ── Untrusted input ──────────────────────────────────────────────────────────

describe("sanitizeWatchStats", () => {
  test("rejects non-objects and missing `by`", () => {
    for (const junk of [null, undefined, 42, "x", [], {}, { by: 7 }])
      expect(sanitizeWatchStats(junk)).toEqual(emptyWatchStats());
  });

  test("clamps device count and day count", () => {
    const by: Record<string, unknown> = {};
    for (let i = 0; i < MAX_DEVICES + 20; i++) by[`d${i}`] = { wall: 1, media: 1, sessions: 1 };
    expect(Object.keys(sanitizeWatchStats({ by }).by).length).toBe(MAX_DEVICES);
  });

  test("drops negative, infinite, and non-numeric counters", () => {
    const out = sanitizeWatchStats({
      by: { d: { wall: -5, media: Infinity, sessions: "many", days: { "2026-07-28": -1 } } },
    });
    expect(out.by.d).toMatchObject({ wall: 0, media: 0, sessions: 0, days: {} });
  });

  test("drops malformed day keys and clamps a day to 24 h", () => {
    const out = sanitizeWatchStats({
      by: { d: { wall: 1, media: 1, sessions: 1, days: { nope: 10, "2026-07-28": 999_999 } } },
    });
    expect(out.by.d.days).toEqual({ "2026-07-28": 86_400 });
  });

  test("drops a coverage blob that isn't base64 or is over-long", () => {
    expect(sanitizeWatchStats({ by: { d: { cov: "<script>" } } }).by.d.cov).toBeUndefined();
    expect(sanitizeWatchStats({ by: { d: { cov: "A".repeat(5000) } } }).by.d.cov).toBeUndefined();
    expect(sanitizeWatchStats({ by: { d: { cov: "AAAA" } } }).by.d.cov).toBe("AAAA");
  });

  test("ignores an over-long device id and over-long strings", () => {
    expect(Object.keys(sanitizeWatchStats({ by: { ["x".repeat(65)]: {} } }).by)).toEqual([]);
    expect(sanitizeWatchStats({ by: { d: { lang: "x".repeat(33) } } }).by.d.lang).toBeUndefined();
  });

  test("survives a round-trip through the DB's JSON column", () => {
    const original = stats({
      d: dev({ wall: 42, media: 50, sessions: 1, days: { "2026-07-28": 42 } }),
    });
    expect(parseWatchStats(JSON.stringify(original))).toEqual(original);
    expect(parseWatchStats(null)).toEqual(emptyWatchStats());
    expect(parseWatchStats("{not json")).toEqual(emptyWatchStats());
  });
});

test("localDayKey formats as YYYY-MM-DD", () => {
  expect(localDayKey(new Date(2026, 6, 28, 12))).toBe("2026-07-28");
});

// ── D1 repo ──────────────────────────────────────────────────────────────────

const SCHEMA = readdirSync(join(process.cwd(), "db/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(process.cwd(), "db/migrations", f), "utf8"))
  .join("\n");
const USER = "watcher@example.com";

describe("WatchStatsD1Repo", () => {
  let d1: TestD1Database;
  let repo: WatchStatsD1Repo;
  beforeEach(() => {
    d1 = createTestD1(SCHEMA);
    repo = new WatchStatsD1Repo(d1 as unknown as D1Like, USER);
  });

  const url = "https://www.youtube.com/watch?v=abc";

  test("returns null before anything is recorded", async () => {
    expect(await repo.getByUrl(url)).toBeNull();
  });

  test("merge inserts, then folds later payloads into the same row", async () => {
    await repo.merge(
      url,
      stats({ a: dev({ wall: 100, media: 120, sessions: 1, lang: "ja" }) }),
      "Vid",
    );
    await repo.merge(url, stats({ b: dev({ wall: 50, media: 55, sessions: 1, lang: "ja" }) }));

    const row = await repo.getByUrl(url);
    expect(row!.wall).toBe(150); // summed across devices
    expect(row!.media).toBe(175);
    expect(row!.lang).toBe("ja");
    expect(row!.title).toBe("Vid"); // preserved when a later POST omits it
    expect(Object.keys(row!.stats.by).sort()).toEqual(["a", "b"]);
  });

  test("replaying the same payload does not inflate the total", async () => {
    const payload = stats({ a: dev({ wall: 100, media: 120, sessions: 1 }) });
    await repo.merge(url, payload);
    await repo.merge(url, payload);
    await repo.merge(url, payload);
    expect((await repo.getByUrl(url))!.wall).toBe(100);
  });

  test("a rewatch on the same url accumulates rather than replacing", async () => {
    await repo.merge(url, stats({ a: dev({ wall: 100, media: 100, sessions: 1 }) }));
    await repo.merge(url, stats({ a: dev({ wall: 260, media: 260, sessions: 2 }) }));
    const row = await repo.getByUrl(url);
    expect(row!.wall).toBe(260);
    expect(summarizeWatch(row!.stats).sessions).toBe(2);
  });

  test("listTop orders by watched time", async () => {
    await repo.merge("https://x/1", stats({ a: dev({ wall: 10, media: 10 }) }));
    await repo.merge("https://x/2", stats({ a: dev({ wall: 900, media: 900 }) }));
    await repo.merge("https://x/3", stats({ a: dev({ wall: 300, media: 300 }) }));
    expect((await repo.listTop()).map((r) => r.url)).toEqual([
      "https://x/2",
      "https://x/3",
      "https://x/1",
    ]);
    expect((await repo.listTop(1)).length).toBe(1);
  });

  test("totalsByLang groups hours by language, unknown grouping as empty", async () => {
    await repo.merge("https://x/1", stats({ a: dev({ wall: 600, media: 600, lang: "ja" }) }));
    await repo.merge("https://x/2", stats({ a: dev({ wall: 300, media: 300, lang: "ja" }) }));
    await repo.merge("https://x/3", stats({ a: dev({ wall: 100, media: 100, lang: "ko" }) }));
    await repo.merge("https://x/4", stats({ a: dev({ wall: 50, media: 50 }) }));

    expect(await repo.totalsByLang()).toEqual([
      { lang: "ja", wall: 900, media: 900, videos: 2 },
      { lang: "ko", wall: 100, media: 100, videos: 1 },
      { lang: "", wall: 50, media: 50, videos: 1 },
    ]);
  });

  test("rows are scoped per user", async () => {
    await repo.merge(url, stats({ a: dev({ wall: 100, media: 100 }) }));
    const other = new WatchStatsD1Repo(d1 as unknown as D1Like, "someone-else@example.com");
    expect(await other.getByUrl(url)).toBeNull();
  });

  test("delete removes the row", async () => {
    await repo.merge(url, stats({ a: dev({ wall: 100, media: 100 }) }));
    await repo.delete(url);
    expect(await repo.getByUrl(url)).toBeNull();
  });
});

// ── Overview / streak ────────────────────────────────────────────────────────

describe("currentStreak", () => {
  const day = (offset: number) => {
    const d = new Date(2026, 7, 1);
    d.setDate(d.getDate() + offset);
    return d.toLocaleDateString("en-CA");
  };
  const NOW = new Date(2026, 7, 10, 12);

  test("counts consecutive days back from today", () => {
    expect(currentStreak({ [day(9)]: 60, [day(8)]: 60, [day(7)]: 60 }, NOW)).toBe(3);
  });

  test("a gap ends the streak", () => {
    expect(currentStreak({ [day(9)]: 60, [day(7)]: 60 }, NOW)).toBe(1);
  });

  test("today being empty does NOT break the streak — the day isn't over", () => {
    // Zeroing someone's streak at 00:01 for not having studied yet would be
    // both wrong and demoralising, so an empty today falls back to yesterday.
    expect(currentStreak({ [day(8)]: 60, [day(7)]: 60 }, NOW)).toBe(2);
  });

  test("no activity at all is zero, not a crash", () => {
    expect(currentStreak({}, NOW)).toBe(0);
  });
});

describe("WatchStatsD1Repo.overview", () => {
  let d1b: TestD1Database;
  let repo2: WatchStatsD1Repo;
  beforeEach(() => {
    d1b = createTestD1(SCHEMA);
    repo2 = new WatchStatsD1Repo(d1b as unknown as D1Like, USER);
  });

  test("aggregates totals, per-day series, languages and top videos", async () => {
    await repo2.merge(
      "https://x/1",
      stats({
        a: dev({ wall: 600, media: 600, sessions: 2, lang: "ja", days: { "2026-08-09": 600 } }),
      }),
      "Vid one",
    );
    await repo2.merge(
      "https://x/2",
      stats({
        a: dev({ wall: 300, media: 300, sessions: 1, lang: "ja", days: { "2026-08-08": 300 } }),
      }),
    );
    await repo2.merge(
      "https://x/3",
      stats({
        a: dev({ wall: 100, media: 100, sessions: 1, lang: "ko", days: { "2026-08-09": 100 } }),
      }),
    );

    const o = await repo2.overview();
    expect(o.totalWall).toBe(1000);
    expect(o.videos).toBe(3);
    expect(o.days).toEqual({ "2026-08-09": 700, "2026-08-08": 300 });
    expect(o.languages[0]).toMatchObject({ lang: "ja", wall: 900, videos: 2 });
    expect(o.top[0]).toMatchObject({
      url: "https://x/1",
      title: "Vid one",
      wall: 600,
      sessions: 2,
    });
  });

  test("empty account returns zeros rather than throwing", async () => {
    const o = await repo2.overview();
    expect(o).toMatchObject({ totalWall: 0, videos: 0, streak: 0, days: {}, top: [] });
  });
});
