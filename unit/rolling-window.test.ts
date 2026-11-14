import { describe, expect, it } from "bun:test";
import {
  HOUR_MS,
  addToBucket,
  fitsAgainAt,
  hourOf,
  inWindow,
  pruneBuckets,
  windowHours,
  windowSum,
} from "@/lib/rolling-window";

describe("rolling window: hourly UTC buckets", () => {
  it("hourOf counts whole UTC hours since the epoch", () => {
    expect(hourOf(0)).toBe(0);
    expect(hourOf(HOUR_MS - 1)).toBe(0);
    expect(hourOf(HOUR_MS)).toBe(1);
    expect(hourOf(Date.parse("2026-11-15T03:59:59Z"))).toBe(
      hourOf(Date.parse("2026-11-15T03:00:00Z")),
    );
  });

  it("the window is the current hour plus the hours - 1 before it", () => {
    expect(inWindow(100, 100, 24)).toBe(true);
    expect(inWindow(77, 100, 24)).toBe(true);
    expect(inWindow(76, 100, 24)).toBe(false);
    expect(inWindow(101, 100, 24)).toBe(false);
  });

  it("windowSum adds only buckets inside the window", () => {
    const b = { 76: 1000, 77: 10, 90: 5, 100: 1, 101: 50 };
    expect(windowSum(b, 100, 24)).toBe(16);
    expect(windowSum(b, 101, 24)).toBe(56);
    expect(windowSum(b, 100, 1)).toBe(1);
    expect(windowSum(undefined, 100, 24)).toBe(0);
    expect(windowSum({ 100: "x" as unknown as number }, 100, 24)).toBe(0);
  });

  it("pruneBuckets drops old, empty and malformed buckets", () => {
    const b = { 76: 1000, 77: 10, 90: 0, 100: 1, 101: 2, nope: 3 } as Record<string, number>;
    expect(pruneBuckets(b, 100, 24)).toEqual({ 77: 10, 100: 1, 101: 2 });
    expect(pruneBuckets(undefined, 100, 24)).toEqual({});
    expect(pruneBuckets({ 100: "x" as unknown as number }, 100, 24)).toEqual({});
  });

  it("addToBucket adds, never goes below zero, and removes an emptied bucket", () => {
    expect(addToBucket(undefined, 5, 10)).toEqual({ 5: 10 });
    expect(addToBucket({ 5: 10 }, 5, -4)).toEqual({ 5: 6 });
    expect(addToBucket({ 5: 10, 6: 1 }, 5, -40)).toEqual({ 6: 1 });
    expect(addToBucket({}, 5, 0)).toEqual({});
    const b = { 5: 1 };
    addToBucket(b, 5, 1);
    expect(b).toEqual({ 5: 1 });
  });

  it("windowHours takes a whole number in [1, max], else the default", () => {
    expect(windowHours(6, 24, 168)).toBe(6);
    expect(windowHours(500, 24, 168)).toBe(168);
    for (const v of [0, -1, 2.5, "6", undefined, null, Number.NaN])
      expect(windowHours(v, 24, 168)).toBe(24);
  });
});

describe("fitsAgainAt: when a capped request fits again", () => {
  const now = 100 * HOUR_MS + 30 * 60_000; // half past hour 100
  it("now when it fits; null when it never can", () => {
    expect(fitsAgainAt({ 99: 10 }, now, 24, 100, 50)).toBe(now);
    expect(fitsAgainAt(undefined, now, 24, 100, 101)).toBeNull();
  });
  it("the start of the hour the oldest needed bucket leaves the window", () => {
    // 80 at hour 80, 15 at hour 95: 95 + 10 > 100. Hour 80 leaves at hour 104.
    expect(fitsAgainAt({ 80: 80, 95: 15 }, now, 24, 100, 10)).toBe(104 * HOUR_MS);
    // Both have to go: hour 95 leaves at hour 119.
    expect(fitsAgainAt({ 80: 50, 95: 50 }, now, 24, 100, 60)).toBe(119 * HOUR_MS);
    // A bucket already out of the window does not count.
    expect(fitsAgainAt({ 70: 1000, 95: 95 }, now, 24, 100, 10)).toBe(119 * HOUR_MS);
  });
});
