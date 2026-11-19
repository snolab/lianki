import { describe, expect, it } from "bun:test";
import {
  isoDay,
  longDate,
  longDateTime,
  NO_DATE,
  shortStamp,
  toDate,
  toEpochMs,
  zonedDateTime,
} from "@/lib/dates";
import { formatZoned, zoneOffsetMin, zoneTag } from "@/lib/time-zone";

describe("dates people read", () => {
  const d = new Date(2026, 10, 5, 18, 11, 15);
  it("writes the month out instead of 11/5/2026", () => {
    expect(longDate(d, "en-US")).toBe("November 5, 2026");
    expect(longDate(d, "zh-CN")).toBe("2026年11月5日");
    expect(longDateTime(d, "en-US")).toContain("November 5, 2026");
    expect(longDateTime(d, "en-US")).not.toContain("11/5");
  });
  it("labels an import with an ISO day", () => {
    expect(isoDay(d)).toBe("2026-11-05");
  });
});

describe("times from an API never throw", () => {
  const ms = 1794387558000; // what /api/dev/flags sent as "1794387558000"
  it("reads epoch milliseconds sent as a string", () => {
    expect(new Date(String(ms)).getTime()).toBeNaN(); // the bug
    expect(toEpochMs(String(ms))).toBe(ms);
    expect(toEpochMs(` ${ms} `)).toBe(ms);
    expect(toEpochMs(ms)).toBe(ms);
    expect(toEpochMs(new Date(ms))).toBe(ms);
    expect(toEpochMs("2026-11-11T08:59:18.000Z")).toBe(ms);
    expect(toDate(String(ms))?.toISOString()).toBe("2026-11-11T08:59:18.000Z");
  });
  it("gives null for what is not a time", () => {
    for (const v of [
      "",
      "x",
      "Invalid Date",
      NaN,
      Infinity,
      1e20,
      null,
      undefined,
      {},
      new Date("x"),
    ])
      expect(toEpochMs(v)).toBeNull();
  });
  it("formats a numeric string, and shows — for garbage instead of throwing", () => {
    expect(formatZoned(String(ms), "Asia/Tokyo", "en-US")).toContain("November 11, 2026");
    expect(formatZoned("x", "Asia/Tokyo", "zh-CN")).toBe(NO_DATE);
    expect(zoneTag("Asia/Tokyo", new Date("x"))).toBe("");
    expect(zoneOffsetMin("Asia/Tokyo", new Date("x"))).toBe(0);
    expect(zonedDateTime("x", "en", "Asia/Tokyo")).toBe(NO_DATE);
    expect(zonedDateTime(String(ms), "en", "UTC")).toContain("November 11, 2026");
    expect(longDate("x")).toBe(NO_DATE);
    expect(longDateTime("x")).toBe(NO_DATE);
    expect(isoDay("x")).toBe(NO_DATE);
    expect(shortStamp(null)).toBe(NO_DATE);
    expect(shortStamp(String(ms))).toMatch(/^2026-11-1\d \d\d:\d\d$/);
  });
});
