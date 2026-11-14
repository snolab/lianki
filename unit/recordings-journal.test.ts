// /my/recordings as one continuous journal (lib/recordings-view.ts; owner,
// 2026-11-15 JST): a feed paged by time, grouped into dates in the device's
// own zone, never JST or a fixed one; the oldest date held back while more may
// belong to it; time marks only now and then. Pure parts only, fixtures only.
import { describe, expect, it } from "bun:test";
import {
  type ClipView,
  cursor,
  deviceZone,
  journal,
  keepLoading,
  mergeClips,
  withoutClip,
  zoneDay,
} from "@/lib/recordings-view";

const MIN = 60_000;
const c = (id: string, iso: string, durationMs = 1_000, more: Partial<ClipView> = {}): ClipView => {
  const at = Date.parse(iso);
  return {
    id,
    day: new Date(at).toISOString().slice(0, 10),
    at,
    durationMs,
    mode: "active",
    source: "local",
    speaker: null,
    text: id,
    ...more,
  };
};

describe("zoneDay: the date in a given zone", () => {
  const at = Date.parse("2026-11-14T16:30:00Z");
  it("is the zone's own calendar date", () => {
    expect(zoneDay(at, "UTC")).toBe("2026-11-14");
    expect(zoneDay(at, "Asia/Tokyo")).toBe("2026-11-15");
    expect(zoneDay(at, "America/Los_Angeles")).toBe("2026-11-14");
    expect(zoneDay(Date.parse("2026-11-15T03:00:00Z"), "America/Los_Angeles")).toBe("2026-11-14");
  });
  it("an unknown zone falls back to UTC, not JST", () => {
    expect(zoneDay(at, "Not/AZone")).toBe("2026-11-14");
    expect(zoneDay(at, "Not/AZone")).toBe("2026-11-14"); // cached
  });
  it("deviceZone names the engine's zone, else UTC", () => {
    expect(deviceZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    const real = Intl.DateTimeFormat;
    try {
      (Intl as { DateTimeFormat: unknown }).DateTimeFormat = () => ({
        resolvedOptions: () => ({ timeZone: "" }),
      });
      expect(deviceZone()).toBe("UTC");
      (Intl as { DateTimeFormat: unknown }).DateTimeFormat = () => {
        throw new Error("no Intl");
      };
      expect(deviceZone()).toBe("UTC");
    } finally {
      (Intl as { DateTimeFormat: unknown }).DateTimeFormat = real;
    }
  });
});

describe("journal: dates newest first, clips oldest first within each", () => {
  // Newest first, as the API sends them; across a UTC midnight that is not Tokyo's.
  const feed = [
    c("e", "2026-11-15T12:00:00Z"),
    c("d", "2026-11-15T02:00:00Z"),
    c("c", "2026-11-14T23:00:00Z"),
    c("b", "2026-11-14T15:30:00Z"),
    c("a", "2026-11-13T10:00:00Z"),
  ];
  it("groups by the device's zone, not the server's day", () => {
    const tokyo = journal(feed, { timeZone: "Asia/Tokyo", gapMs: 10 * MIN, more: false });
    expect(tokyo.rows.map((r) => r.key)).toEqual([
      "d:2026-11-15",
      "c:b",
      "c:c",
      "c:d",
      "c:e",
      "d:2026-11-13",
      "c:a",
    ]);
    expect(tokyo.held).toBeNull();
    expect([...tokyo.groups.keys()]).toEqual(["2026-11-15", "2026-11-13"]);
    const utc = journal(feed, { timeZone: "UTC", gapMs: 10 * MIN, more: false });
    expect(utc.rows.filter((r) => r.kind === "date").map((r) => r.day)).toEqual([
      "2026-11-15",
      "2026-11-14",
      "2026-11-13",
    ]);
    // Each clip row names its date (the player's group) and its paragraph.
    const row = utc.rows.find((r) => r.key === "c:c");
    expect(row?.kind === "clip" && [row.day, row.p.startMs, row.p.time]).toEqual([
      "2026-11-14",
      1_000,
      true, // 7.5 h after b
    ]);
  });
  it("holds back the oldest date while more may belong to it", () => {
    const j = journal(feed, { timeZone: "UTC", gapMs: 10 * MIN, more: true });
    expect(j.held).toBe("2026-11-13");
    expect(j.rows.some((r) => r.key === "c:a")).toBe(false);
    expect(j.groups.has("2026-11-13")).toBe(false);
    // A first page all of one date shows nothing yet.
    expect(journal(feed.slice(0, 2), { timeZone: "UTC", gapMs: MIN, more: true }).rows).toEqual([]);
    expect(journal([], { timeZone: "UTC", gapMs: MIN, more: true })).toEqual({
      rows: [],
      groups: new Map(),
      held: null,
    });
  });
  it("sparse time marks: the date's first line and after a pause", () => {
    const day = [
      c("p3", "2026-11-14T10:30:00Z"),
      c("p2", "2026-11-14T10:05:00Z"),
      c("p1", "2026-11-14T10:00:00Z"),
    ];
    const j = journal(day, { timeZone: "UTC", gapMs: 10 * MIN, more: false });
    expect(j.groups.get("2026-11-14")!.map((p) => [p.c.id, p.time])).toEqual([
      ["p1", true],
      ["p2", false],
      ["p3", true],
    ]);
  });
});

describe("the feed: merging pages, the cursor, deletes", () => {
  const a = c("a", "2026-11-14T10:00:00Z");
  const b = c("b", "2026-11-14T11:00:00Z");
  const b2 = c("b2", "2026-11-14T11:00:00Z");
  it("merges without duplicates, newest first, ties by id", () => {
    expect(mergeClips([b], [a, b, b2]).map((x) => x.id)).toEqual(["b2", "b", "a"]);
    expect(mergeClips([b2, a], [b]).map((x) => x.id)).toEqual(["b2", "b", "a"]);
    expect(mergeClips([], [b, b]).map((x) => x.id)).toEqual(["b"]);
  });
  it("the cursor is the oldest loaded time", () => {
    expect(cursor([])).toBeUndefined();
    expect(cursor([b, a])).toBe(a.at);
  });
  it("a deleted clip leaves the feed; a second delete changes nothing", () => {
    const once = withoutClip([a, b], "a");
    expect(once.map((x) => x.id)).toEqual(["b"]);
    expect(withoutClip(once, "a")).toEqual(once);
  });
});

describe("keepLoading: fetch on while only the held date grew", () => {
  const d14a = c("x", "2026-11-14T20:00:00Z");
  const d14b = c("y", "2026-11-14T08:00:00Z");
  const d13 = c("z", "2026-11-13T08:00:00Z");
  it("a first page of one date, or a page that only extends the held date", () => {
    expect(keepLoading([], [d14a, d14b], true, "UTC")).toBe(true);
    expect(keepLoading([d14a], [d14b], true, "UTC")).toBe(true);
  });
  it("stops when a date opened, nothing more exists, or the page was empty", () => {
    expect(keepLoading([], [d14a, d13], true, "UTC")).toBe(false);
    expect(keepLoading([d14a], [d13], true, "UTC")).toBe(false);
    expect(keepLoading([d14a], [d14b], false, "UTC")).toBe(false);
    expect(keepLoading([d14a], [], true, "UTC")).toBe(false);
  });
  it("reads the dates in the viewer's zone", () => {
    // 2026-11-14T20:00Z and 2026-11-15T01:00Z are one date in Los Angeles, two in UTC.
    const later = c("w", "2026-11-15T01:00:00Z");
    expect(keepLoading([later], [d14a], true, "America/Los_Angeles")).toBe(true);
    expect(keepLoading([later], [d14a], true, "UTC")).toBe(false);
  });
});
