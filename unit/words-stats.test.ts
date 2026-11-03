import { describe, expect, test } from "bun:test";
import { createTestD1 } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import {
  STATS_WEEKS,
  dayKey,
  gridWeeks,
  inkScale,
  offsetSpans,
  sealTilt,
  shiftDay,
  streak,
  sumByDay,
  tzName,
  tzOffset,
  zoneOffset,
  type StatsTuple,
} from "@/lib/words/stats";

const days = (pairs: [string, number][]) =>
  new Map(pairs.map(([d, words]) => [d, { words, fresh: 0 }]));

describe("streak: days in a row ending today", () => {
  const today = new Date(2026, 10, 3, 14);
  test("counts back from today", () => {
    expect(
      streak(
        days([
          ["2026-11-03", 5],
          ["2026-11-02", 1],
          ["2026-11-01", 2],
        ]),
        today,
      ),
    ).toBe(3);
  });
  test("not yet studied today: counts up to yesterday", () => {
    expect(
      streak(
        days([
          ["2026-11-02", 1],
          ["2026-11-01", 2],
        ]),
        today,
      ),
    ).toBe(2);
  });
  test("a gap ends it", () => {
    expect(
      streak(
        days([
          ["2026-11-03", 1],
          ["2026-11-01", 2],
        ]),
        today,
      ),
    ).toBe(1);
    expect(streak(days([["2026-10-31", 1]]), today)).toBe(0);
  });
  test("across a month end", () => {
    expect(
      streak(
        days([
          ["2026-11-01", 1],
          ["2026-10-31", 1],
          ["2026-10-30", 1],
        ]),
        new Date(2026, 10, 1),
      ),
    ).toBe(3);
  });
});

describe("grid", () => {
  test("weeks Sunday first, today in the last column, the future blank", () => {
    const today = new Date(2026, 10, 3); // a Tuesday
    const g = gridWeeks(today);
    expect(g).toHaveLength(STATS_WEEKS);
    const last = g.at(-1)!;
    expect(last[0]).toBe("2026-11-01"); // Sunday
    expect(last[2]).toBe(dayKey(today));
    expect(last.slice(3)).toEqual([null, null, null, null]);
    expect(g[0][0]).toBe("2026-05-10");
    expect(g.flat().filter(Boolean)).toHaveLength((STATS_WEEKS - 1) * 7 + 3);
  });
});

describe("ink scale: against the reader's own busy days", () => {
  test("0 for no study, the top for a busy day", () => {
    const scale = inkScale(
      days([
        ["a", 10],
        ["b", 20],
        ["c", 40],
        ["d", 80],
      ]),
    );
    expect(scale(0)).toBe(0);
    expect(scale(1)).toBe(1);
    expect(scale(80)).toBe(4);
    expect(scale(500)).toBe(4);
  });
  test("five steps for 正", () => {
    const five = inkScale(days([["a", 50]]), 5);
    expect([10, 20, 30, 40, 50].map(five)).toEqual([1, 2, 3, 4, 5]);
  });
});

test("sumByDay keeps only the page's lists", () => {
  const rows: StatsTuple[] = [
    ["2026-11-03", "w1", 10, 3],
    ["2026-11-03", "w2", 5, 1],
    ["2026-11-03", "abc", 99, 99],
  ];
  expect(sumByDay(rows, new Set(["w1", "w2"])).get("2026-11-03")).toEqual({ words: 15, fresh: 4 });
});

describe("repo", () => {
  test("activity: per local day, distinct words, new ones, only this user's", async () => {
    const d1 = createTestD1(testSchema());
    const me = new WordsD1Repo(d1, "me@example.com");
    const other = new WordsD1Repo(d1, "other@example.com");
    const id = await me.createList({ name: "x", lang: "fr" });
    // 16:00 UTC on 2 November is 01:00 on 3 November in Tokyo.
    await me.review(
      id,
      [
        { term: "a", rating: 3, reviewedAt: "2026-11-02T16:00:00.000Z" },
        { term: "b", rating: 1, reviewedAt: "2026-11-02T16:01:00.000Z" },
      ],
      "2026-11-03",
      new Date("2026-11-03T00:00:00Z"),
    );
    await me.review(
      id,
      [{ term: "b", rating: 3, reviewedAt: "2026-11-03T03:00:00.000Z" }],
      "2026-11-03",
      new Date("2026-11-03T03:00:00Z"),
    );
    const oid = await other.createList({ name: "y", lang: "fr" });
    await other.review(oid, [{ term: "z", rating: 3 }], "2026-11-03");

    const since = new Date("2026-10-01T00:00:00Z");
    expect(await me.activity(since, 540)).toEqual([
      { day: "2026-11-03", list_id: id, words: 2, fresh: 2 },
    ]);
    const utc = await me.activity(since, 0);
    expect(utc.sort((x, y) => x.day.localeCompare(y.day))).toEqual([
      { day: "2026-11-02", list_id: id, words: 2, fresh: 2 },
      { day: "2026-11-03", list_id: id, words: 1, fresh: 0 },
    ]);
    // New York (UTC-5): both reviews fall on 2 November.
    expect(await me.activity(since, -300)).toEqual([
      { day: "2026-11-02", list_id: id, words: 2, fresh: 2 },
    ]);
  });

  test("history: one word's grades oldest first, only this user's", async () => {
    const d1 = createTestD1(testSchema());
    const me = new WordsD1Repo(d1, "me@example.com");
    const id = await me.createList({ name: "x", lang: "fr" });
    const at = (h: number) => new Date(Date.UTC(2026, 10, h));
    for (const [h, rating] of [
      [1, 1],
      [2, 1],
      [5, 4],
      [20, 4],
    ] as const)
      await me.review(id, [{ term: "a", rating, reviewedAt: at(h).toISOString() }], "d", at(h));
    expect((await me.history(id, "a")).map((r) => r.rating)).toEqual([1, 1, 4, 4]);
    expect(await new WordsD1Repo(d1, "other@example.com").history(id, "a")).toEqual([]);
  });
});

test("seal tilt: small, stable per day; tz offset is minutes east", () => {
  expect(sealTilt("2026-11-03")).toBe(sealTilt("2026-11-03"));
  for (const d of ["2026-11-01", "2026-11-02", "2026-11-03", "x"])
    expect(Math.abs(sealTilt(d))).toBeLessThanOrEqual(6);
  expect(tzOffset(new Date())).toBe(-new Date().getTimezoneOffset());
});

describe("time zones: each review on the day it had then", () => {
  test("zone offsets, minutes east; unknown zone is null", () => {
    expect(zoneOffset("Asia/Tokyo", new Date("2026-11-03T00:00:00Z"))).toBe(540);
    expect(zoneOffset("UTC", new Date("2026-11-03T00:00:00Z"))).toBe(0);
    expect(zoneOffset("Asia/Kathmandu", new Date("2026-11-03T00:00:00Z"))).toBe(345);
    expect(zoneOffset("America/New_York", new Date("2026-07-01T00:00:00Z"))).toBe(-240);
    expect(zoneOffset("Not/AZone", new Date())).toBeNull();
    expect(typeof tzName()).toBe("string");
  });
  test("spans split at DST, to the minute", () => {
    const since = new Date("2026-05-01T00:00:00Z");
    const now = new Date("2026-11-03T05:00:00Z");
    expect(offsetSpans("America/New_York", since, now)).toEqual([
      // 1 November 2026, 02:00 EDT = 06:00 UTC
      { until: "2026-11-01T06:00:00.000Z", offset: -240 },
      { until: null, offset: -300 },
    ]);
    expect(offsetSpans("Asia/Tokyo", since, now)).toEqual([{ until: null, offset: 540 }]);
    expect(offsetSpans("Nope/Nope", since, now)).toBeNull();
  });
  test("shiftDay crosses months and DST", () => {
    expect(shiftDay("2026-11-01", -1)).toBe("2026-10-31");
    expect(shiftDay("2026-10-31", 7)).toBe("2026-11-07");
    expect(shiftDay("2026-03-07", 1)).toBe("2026-03-08");
  });
  test("the repo buckets by the offset each review had", async () => {
    const d1 = createTestD1(testSchema());
    const me = new WordsD1Repo(d1, "me@example.com");
    const id = await me.createList({ name: "x", lang: "en" });
    // 04:30 UTC on 31 October is 00:30 EDT on 31 October (UTC-4 then);
    // today's UTC-5 would put it on 30 October.
    await me.review(
      id,
      [{ term: "a", rating: 3, reviewedAt: "2026-10-31T04:30:00.000Z" }],
      "d",
      new Date("2026-10-31T04:30:00Z"),
    );
    const since = new Date("2026-10-01T00:00:00Z");
    const spans = offsetSpans("America/New_York", since, new Date("2026-11-03T05:00:00Z"))!;
    expect((await me.activity(since, spans)).map((r) => r.day)).toEqual(["2026-10-31"]);
    expect((await me.activity(since, -300)).map((r) => r.day)).toEqual(["2026-10-30"]);
  });
});
