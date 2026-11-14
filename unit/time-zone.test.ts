import { describe, expect, it } from "bun:test";
import {
  MAX_OFFSET_MIN,
  MIN_OFFSET_MIN,
  dayStartMs,
  endOfDayIso,
  deviceZone,
  localDay,
  localHour,
  offsetLabel,
  ownerZone,
  parseOffsetMin,
  validZone,
  zoneAbbr,
  zoneLabel,
  zoneOffsetMin,
} from "@/lib/time-zone";

describe("time zones: no fixed default", () => {
  it("validZone knows IANA zones and refuses the rest", () => {
    expect(validZone("Asia/Tokyo")).toBe(true);
    expect(validZone("UTC")).toBe(true);
    for (const z of ["Mars/Base", "", 5, null, "x".repeat(65)]) expect(validZone(z)).toBe(false);
  });

  it("deviceZone is this runtime's zone, a valid one", () => {
    const z = deviceZone();
    expect(validZone(z)).toBe(true);
    expect(z).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });

  it("deviceZone falls back to UTC when the runtime gives none", () => {
    const orig = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      return { ...orig.call(this), timeZone: "" };
    };
    try {
      expect(deviceZone()).toBe("UTC");
      Intl.DateTimeFormat.prototype.resolvedOptions = () => {
        throw new Error("no Intl");
      };
      expect(deviceZone()).toBe("UTC");
    } finally {
      Intl.DateTimeFormat.prototype.resolvedOptions = orig;
    }
  });

  it("ownerZone: LIANKI_OWNER_TZ when valid, else the machine's", () => {
    expect(ownerZone({ LIANKI_OWNER_TZ: "Europe/Berlin" })).toBe("Europe/Berlin");
    expect(ownerZone({ LIANKI_OWNER_TZ: "Nowhere/Land" })).toBe(deviceZone());
    expect(ownerZone({})).toBe(deviceZone());
    expect(validZone(ownerZone())).toBe(true);
  });

  it("zoneOffsetMin follows daylight saving and half-hour zones", () => {
    const winter = Date.parse("2026-01-15T12:00:00Z");
    const summer = Date.parse("2026-07-15T12:00:00Z");
    expect(zoneOffsetMin("Asia/Tokyo", winter)).toBe(540);
    expect(zoneOffsetMin("Europe/Berlin", winter)).toBe(60);
    expect(zoneOffsetMin("Europe/Berlin", summer)).toBe(120);
    expect(zoneOffsetMin("America/New_York", new Date(winter))).toBe(-300);
    expect(zoneOffsetMin("Asia/Kolkata", winter)).toBe(330);
    expect(zoneOffsetMin("UTC", winter)).toBe(0);
    expect(zoneOffsetMin("Nowhere/Land", winter)).toBe(0);
    expect(typeof zoneOffsetMin("UTC")).toBe("number");
  });

  it("parseOffsetMin: whole minutes within real offsets, UTC otherwise", () => {
    expect(parseOffsetMin("540")).toBe(540);
    expect(parseOffsetMin("-300")).toBe(-300);
    expect(parseOffsetMin("9999")).toBe(MAX_OFFSET_MIN);
    expect(parseOffsetMin("-9999")).toBe(MIN_OFFSET_MIN);
    for (const s of [null, undefined, "", "x", "1.5"]) expect(parseOffsetMin(s)).toBe(0);
  });

  it("offsetLabel and zoneLabel name the offset", () => {
    expect(offsetLabel(0)).toBe("UTC");
    expect(offsetLabel(540)).toBe("UTC+9");
    expect(offsetLabel(-300)).toBe("UTC−5");
    expect(offsetLabel(330)).toBe("UTC+5:30");
    expect(offsetLabel(-570)).toBe("UTC−9:30");
    expect(zoneLabel("UTC")).toBe("UTC");
    expect(zoneLabel("Asia/Tokyo")).toBe("Asia/Tokyo, UTC+9");
  });

  it("localDay / localHour / dayStartMs at an offset", () => {
    const t = Date.parse("2026-11-10T15:30:00Z");
    expect(localDay(t)).toBe("2026-11-10");
    expect(localDay(t, 540)).toBe("2026-11-11");
    expect(localDay(new Date(t), -960)).toBe("2026-11-09");
    expect(localHour(t)).toBe("2026-11-10T15");
    expect(localHour(t, 540)).toBe("2026-11-11T00");
    expect(dayStartMs("2026-11-11", 540)).toBe(Date.parse("2026-11-10T15:00:00Z"));
    expect(dayStartMs("2026-11-11")).toBe(Date.parse("2026-11-11T00:00:00Z"));
  });

  it("zoneAbbr: an English short name where one exists, else numeric; cached", () => {
    const winter = Date.parse("2026-01-15T12:00:00Z");
    expect(zoneAbbr("Asia/Tokyo", winter)).toBe("JST");
    expect(zoneAbbr("America/New_York", winter)).toBe("EST");
    expect(zoneAbbr("UTC", winter)).toBe("UTC");
    expect(zoneAbbr("Nowhere/Land", winter)).toBe("UTC");
    // Asked again: the cached answer.
    expect(zoneAbbr("Asia/Tokyo", winter)).toBe("JST");
    // A zone no English locale names keeps its numeric form.
    expect(zoneAbbr("Asia/Shanghai", winter)).toMatch(/^(GMT\+8|CST)$/);
    expect(typeof zoneAbbr("UTC")).toBe("string");
  });

  it("zoneAbbr survives a locale the runtime refuses", () => {
    const Orig = Intl.DateTimeFormat;
    let calls = 0;
    const Fake = function (this: unknown, loc: string, o: Intl.DateTimeFormatOptions) {
      calls++;
      if (loc.startsWith("en-") && loc !== "en-US") throw new RangeError("no such locale");
      return new Orig(loc, o);
    } as unknown as typeof Intl.DateTimeFormat;
    Intl.DateTimeFormat = Fake;
    try {
      expect(zoneAbbr("Asia/Seoul", Date.parse("2026-01-15T12:00:00Z"))).toBe("GMT+9");
      expect(calls).toBeGreaterThan(2);
    } finally {
      Intl.DateTimeFormat = Orig;
    }
  });
});

describe("endOfDayIso", () => {
  it("the day's last second in the zone, as a UTC instant", () => {
    expect(endOfDayIso("2026-11-20", "Asia/Tokyo")).toBe("2026-11-20T14:59:59.000Z");
    expect(endOfDayIso("2026-11-20", "UTC")).toBe("2026-11-20T23:59:59.000Z");
    expect(endOfDayIso("2026-07-01", "Europe/Berlin")).toBe("2026-07-01T21:59:59.000Z");
    expect(endOfDayIso("2026-01-01", "America/New_York")).toBe("2026-01-02T04:59:59.000Z");
  });
});
