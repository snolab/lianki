import { describe, expect, test } from "bun:test";
import {
  STATS_WEEKS,
  WEEK,
  gridFor,
  periodEnd,
  simulateHistory,
  todayVsUsual,
  tooShort,
  weekStart,
  weeksBetween,
  type StatsTuple,
} from "@/lib/words/stats";

const days = (pairs: [string, number][]) =>
  new Map(pairs.map(([d, words]) => [d, { words, fresh: 0 }]));
// Tuesday 2026-11-03.
const TODAY = "2026-11-03";

describe("weeks", () => {
  test("weekStart is the Sunday", () => {
    expect(weekStart("2026-11-03")).toBe("2026-11-01");
    expect(weekStart("2026-11-01")).toBe("2026-11-01");
    expect(weekStart("2026-10-31")).toBe("2026-10-25");
  });
  test("weeksBetween counts both ends", () => {
    expect(weeksBetween("2026-11-03", "2026-11-07")).toBe(1);
    expect(weeksBetween("2026-10-31", "2026-11-01")).toBe(2);
    expect(weeksBetween("2026-03-01", "2026-11-03")).toBe(36);
  });
  test("periodEnd: the Saturday closing the month's last week", () => {
    expect(periodEnd("2026-11-03")).toBe("2026-12-05"); // Nov 30 is a Monday
    expect(periodEnd("2026-10-15")).toBe("2026-10-31"); // Oct 31 is a Saturday
  });
});

describe("too short: fewer studied days than a grid column (a week)", () => {
  test("threshold is one week of studied days", () => {
    const six = days(Array.from({ length: WEEK - 1 }, (_, i) => [`2026-10-2${i}`, 3]));
    expect(tooShort(six)).toBe(true);
    six.set("2026-10-30", { words: 1, fresh: 0 });
    expect(tooShort(six)).toBe(false);
  });
  test("days with no words do not count", () => {
    expect(tooShort(days([["2026-11-01", 0]]))).toBe(true);
    expect(tooShort(new Map())).toBe(true);
  });
});

describe("gridFor", () => {
  const short = days([
    ["2026-10-29", 4],
    ["2026-11-03", 2],
  ]);
  test("full: the whole span, today's week last, as before", () => {
    const g = gridFor("full", short, TODAY);
    expect(g.length).toBe(STATS_WEEKS);
    expect(g.at(-1)![0]).toBe("2026-11-01");
    expect(g.every((c) => c.length === WEEK)).toBe(true);
  });
  test("grow: from the first studied week only", () => {
    const g = gridFor("grow", short, TODAY);
    expect(g.length).toBe(2);
    expect(g[0][0]).toBe("2026-10-25");
    expect(g.at(-1)!.at(-1)).toBe("2026-11-07");
  });
  test("grow with no history: this week alone", () => {
    expect(gridFor("grow", new Map(), TODAY).length).toBe(1);
  });
  test("grow never beyond the data read", () => {
    const long = days([["2025-01-01", 1]]);
    expect(gridFor("grow", long, TODAY).length).toBe(STATS_WEEKS);
  });
  test("ahead: the same span, ending at the period's end", () => {
    const g = gridFor("ahead", short, TODAY);
    expect(g.length).toBe(STATS_WEEKS);
    expect(g.at(-1)!.at(-1)).toBe("2026-12-05");
  });
  test("grow-ahead: first studied week to the period's end", () => {
    const g = gridFor("grow-ahead", short, TODAY);
    expect(g[0][0]).toBe("2026-10-25");
    expect(g.at(-1)!.at(-1)).toBe("2026-12-05");
    expect(g.length).toBe(6);
  });
  test("future studied days (clock skew) do not start the grid", () => {
    expect(gridFor("grow", days([["2026-12-01", 1]]), TODAY).length).toBe(1);
  });
});

describe("today against his usual day", () => {
  test("first day: nothing to compare with", () => {
    expect(todayVsUsual(days([[TODAY, 5]]), TODAY)).toEqual({
      today: 5,
      usual: null,
      ratio: null,
    });
  });
  test("mean over earlier studied days only", () => {
    const r = todayVsUsual(
      days([
        ["2026-10-30", 10],
        ["2026-10-31", 0],
        ["2026-11-01", 20],
        [TODAY, 30],
      ]),
      TODAY,
    );
    expect(r.usual).toBe(15);
    expect(r.ratio).toBe(2);
  });
  test("not studied yet today", () => {
    expect(todayVsUsual(days([["2026-11-01", 8]]), TODAY).ratio).toBe(0);
  });
});

test("simulateHistory keeps the last n days, today counted", () => {
  const rows: StatsTuple[] = [
    ["2026-10-30", "a", 1, 1],
    ["2026-11-01", "a", 2, 0],
    ["2026-11-03", "b", 3, 1],
  ];
  expect(simulateHistory(rows, TODAY, 1).map((r) => r[0])).toEqual(["2026-11-03"]);
  expect(simulateHistory(rows, TODAY, 3).map((r) => r[0])).toEqual(["2026-11-01", "2026-11-03"]);
});
