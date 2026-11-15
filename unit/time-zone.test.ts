import { describe, expect, it } from "bun:test";
import {
  MAX_OFFSET_MIN,
  MIN_OFFSET_MIN,
  dayStartMs,
  endOfDayIso,
  formatZoned,
  zoneTag,
  zonedStamp,
  deviceZone,
  localDay,
  localHour,
  offsetLabel,
  ownerZone,
  parseOffsetMin,
  validZone,
  zoneAbbr,
  abbrFallback,
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

  it("abbrFallback: the conventional letters when ICU has none (small-ICU runtimes), by offset", () => {
    expect(abbrFallback("Asia/Tokyo", 540)).toBe("JST");
    expect(abbrFallback("America/New_York", -240)).toBe("EDT");
    expect(abbrFallback("Europe/Berlin", 120)).toBe("CEST");
    expect(abbrFallback("Asia/Tokyo", 480)).toBeNull();
    expect(abbrFallback("Pacific/Chatham", 765)).toBeNull();
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
      // Every English locale refused: the conventional letters from the fallback table.
      expect(zoneAbbr("Asia/Seoul", Date.parse("2026-01-15T12:00:00Z"))).toBe("KST");
      // A zone the table does not know stays numeric.
      expect(zoneAbbr("Pacific/Chatham", Date.parse("2026-01-15T12:00:00Z"))).toMatch(
        /^GMT\+1[23]/,
      );
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

describe("zoneTag / formatZoned", () => {
  const winter = Date.parse("2026-01-15T12:00:00Z");
  it("an English abbreviation where en-US has one, else the offset", () => {
    expect(zoneTag("America/New_York", winter)).toBe("EST");
    expect(zoneTag("Asia/Tokyo", winter)).toBe("UTC+9");
    expect(zoneTag("Asia/Kolkata", winter)).toBe("UTC+5:30");
    expect(zoneTag("UTC", winter)).toBe("UTC");
    expect(zoneTag("Etc/UTC", winter)).toBe("UTC");
    expect(zoneTag("Nowhere/Land", winter)).toBe("UTC");
    expect(typeof zoneTag("Europe/Berlin")).toBe("string");
  });
  it("formats in the zone and labels it", () => {
    expect(formatZoned(winter, "Asia/Tokyo", "en-US", { timeStyle: "short" })).toBe(
      "9:00 PM UTC+9",
    );
    expect(
      formatZoned("2026-01-15T12:00:00Z", "Nowhere/Land", "sv-SE", {
        dateStyle: "short",
        timeStyle: "short",
      }),
    ).toBe("2026-01-15 12:00 UTC");
    expect(formatZoned(new Date(winter), "UTC", "en-US")).toContain("UTC");
  });
});

describe("zonedStamp and the scripts' owner time", () => {
  it("the wall clock of a zone, with or without seconds", () => {
    const t = Date.parse("2026-11-07T01:02:03Z");
    expect(zonedStamp(t, "Asia/Tokyo")).toBe("2026-11-07 10:02");
    expect(zonedStamp(new Date(t), "UTC", true)).toBe("2026-11-07 01:02:03");
    expect(zonedStamp(t, "America/New_York", true)).toBe("2026-11-06 20:02:03");
  });
  it("owner-time follows LIANKI_OWNER_TZ", async () => {
    const o = await import("@/scripts/dev/owner-time");
    const prev = process.env.LIANKI_OWNER_TZ;
    const t = Date.parse("2026-11-07T01:02:03Z");
    try {
      process.env.LIANKI_OWNER_TZ = "Europe/Berlin";
      expect(o.ownerStamp(t)).toBe("2026-11-07 02:02 CET");
      expect(o.ownerStamp(t, true)).toBe("2026-11-07 02:02:03 CET");
      expect(o.ownerStampBare(t)).toBe("2026-11-07 02:02");
      expect(o.ownerClock(t)).toBe("02:02");
      expect(o.ownerTag(t)).toBe("CET");
      expect(typeof o.ownerTag()).toBe("string");
      process.env.LIANKI_OWNER_TZ = "Asia/Tokyo";
      expect(o.ownerStamp(t)).toBe("2026-11-07 10:02 JST");
    } finally {
      if (prev === undefined) delete process.env.LIANKI_OWNER_TZ;
      else process.env.LIANKI_OWNER_TZ = prev;
    }
  });
});
