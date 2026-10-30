import { describe, expect, test } from "bun:test";
import {
  addDays,
  dayStartUtc,
  isoUtcMinute,
  isValidTimeZone,
  localDay,
  offsetMinutes,
  resolveTimeZone,
} from "@/lib/tree/tz";

describe("time zones", () => {
  test("an unknown zone resolves to UTC, marked unknown — never a guessed zone", () => {
    expect(resolveTimeZone(undefined, null)).toEqual({ tz: "UTC", known: false });
    expect(resolveTimeZone("Mars/Olympus", "")).toEqual({ tz: "UTC", known: false });
    expect(resolveTimeZone(null, "Europe/Berlin")).toEqual({ tz: "Europe/Berlin", known: true });
    expect(resolveTimeZone("Asia/Tokyo", "Europe/Berlin").tz).toBe("Asia/Tokyo");
  });

  test("UTC is written out with an explicit Z", () => {
    expect(isoUtcMinute("2026-10-31T09:00:12.345Z")).toBe("2026-10-31T09:00Z");
  });

  test("validates names", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("nope")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  test("offsets, including DST and half-hour zones", () => {
    expect(offsetMinutes("Asia/Tokyo", Date.parse("2026-10-31T00:00:00Z"))).toBe(540);
    expect(offsetMinutes("Asia/Kolkata", Date.parse("2026-10-31T00:00:00Z"))).toBe(330);
    expect(offsetMinutes("Europe/Berlin", Date.parse("2026-07-01T00:00:00Z"))).toBe(120);
    expect(offsetMinutes("Europe/Berlin", Date.parse("2026-12-01T00:00:00Z"))).toBe(60);
  });

  test("local day starts", () => {
    expect(dayStartUtc("Asia/Tokyo", "2026-11-02").toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(dayStartUtc("UTC", "2026-11-02").toISOString()).toBe("2026-11-02T00:00:00.000Z");
    // Europe/Berlin leaves DST on 2026-10-25: that day is 25 hours long.
    const a = dayStartUtc("Europe/Berlin", "2026-10-25").getTime();
    const b = dayStartUtc("Europe/Berlin", "2026-10-26").getTime();
    expect((b - a) / 3600_000).toBe(25);
    expect(localDay("Asia/Tokyo", Date.parse("2026-11-01T15:00:00Z"))).toBe("2026-11-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
