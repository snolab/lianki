// When the reader offers to tidy a raw transcript (lib/read/polish-offer.ts).
import { describe, expect, it } from "bun:test";
import {
  SKIPS_MAX,
  checkSkips,
  offerShown,
  polishActionShown,
  withSkip,
  type OfferState,
} from "@/lib/read/polish-offer";
import { checkPref } from "@/lib/prefs/schema";
import type { TextShape } from "@/lib/read/prep";

const shape = (raw: boolean): TextShape => ({
  v: 1,
  raw,
  mixed: false,
  langs: ["en"],
  signals: { longParas: 0, lowerStarts: 0, unended: 0, fillers: 0 },
});
const polished = { at: "2026-11-06T00:00:00.000Z", chunks: 1, kept: 1 };
const base: OfferState = {
  book: { source: "gdoc", shape: shape(true) },
  stream: null,
  offerOn: true,
  skipped: false,
};

describe("offerShown", () => {
  it("offers a raw transcript nobody is writing", () => {
    expect(offerShown(base)).toBe(true);
  });

  it("asks only about what the detector called raw, and not twice", () => {
    expect(offerShown({ ...base, book: { source: "gdoc", shape: shape(false) } })).toBe(false);
    expect(offerShown({ ...base, book: { source: "gdoc" } })).toBe(false);
    expect(offerShown({ ...base, book: null })).toBe(false);
    expect(offerShown({ ...base, book: { source: "gdoc", shape: shape(true), polished } })).toBe(
      false,
    );
  });

  it("a no sticks: for this text, and for all of them", () => {
    expect(offerShown({ ...base, skipped: true })).toBe(false);
    expect(offerShown({ ...base, offerOn: false })).toBe(false);
  });

  // "when we are still in meeting": no state of the socket means the writing ended.
  for (const stream of ["connecting", "live", "offline"] as const) {
    it(`stays away while the page follows a stream (${stream})`, () => {
      expect(offerShown({ ...base, stream })).toBe(false);
    });
  }
});

describe("polishActionShown", () => {
  it("is there whatever the offer says", () => {
    expect(polishActionShown(base.book)).toBe(true);
    expect(polishActionShown({ source: "epub", shape: shape(true) })).toBe(true);
  });

  it("any Google Doc, even one the detector did not call raw", () => {
    expect(polishActionShown({ source: "gdoc", shape: shape(false) })).toBe(true);
    expect(polishActionShown({ source: "gdoc" })).toBe(true);
  });

  it("never on an edited book, nor a tidied text", () => {
    expect(polishActionShown({ source: "epub", shape: shape(false) })).toBe(false);
    expect(polishActionShown({ source: "preset" })).toBe(false);
    expect(polishActionShown({ source: "gdoc", shape: shape(true), polished })).toBe(false);
    expect(polishActionShown(null)).toBe(false);
  });
});

describe("the list of texts he said no to", () => {
  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

  it("adds once, newest last, and keeps the newest", () => {
    expect(withSkip(["a"], "a")).toEqual(["a"]);
    expect(withSkip(["a"], "b")).toEqual(["a", "b"]);
    let list: string[] = [];
    for (let i = 0; i <= SKIPS_MAX; i++) list = withSkip(list, uuid(i));
    expect(list).toHaveLength(SKIPS_MAX);
    expect(list[0]).toBe(uuid(1));
    expect(list.at(-1)).toBe(uuid(SKIPS_MAX));
  });

  it("drops what is not an id", () => {
    expect(checkSkips(["ok-1", "https://example.test/x", 3, null])).toEqual(["ok-1"]);
    expect(checkSkips("nope")).toEqual([]);
  });

  it("a full list passes the account's schema and its 2 KB cap", () => {
    const full = Array.from({ length: SKIPS_MAX }, (_, i) => uuid(i));
    expect(checkPref("read.polishSkips", full)).toEqual(full);
    expect(JSON.stringify(full).length).toBeLessThan(2048);
    expect(checkPref("read.polishSkips", ["https://example.test"])).toBeUndefined();
    expect(checkPref("read.polishSkips", [...full, uuid(99)])).toBeUndefined();
  });
});
