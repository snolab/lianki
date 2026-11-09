// When the reader offers to tidy a raw transcript (lib/read/polish-offer.ts).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  OFFER_KEY,
  SKIPS_KEY,
  SKIPS_MAX,
  carryDeviceSkip,
  checkSkips,
  deviceSkipKey,
  offerShown,
  polishActionShown,
  readOfferOn,
  readSkipped,
  withSkip,
  writeOfferOn,
  writeSkip,
  type OfferState,
  draftChoiceShown,
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

describe("where his answers are kept", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let store: Map<string, string>;
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  beforeEach(() => {
    store = new Map();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fake });
  });
  afterEach(() => {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("the switch: on until he says otherwise", () => {
    expect(readOfferOn()).toBe(true);
    writeOfferOn(false);
    expect(store.get(OFFER_KEY)).toBe("0");
    expect(readOfferOn()).toBe(false);
    writeOfferOn(true);
    expect(readOfferOn()).toBe(true);
  });

  it("a no goes on the account's list and on this device", () => {
    expect(readSkipped("a")).toBe(false);
    writeSkip("a");
    expect(readSkipped("a")).toBe(true);
    expect(readSkipped("b")).toBe(false);
    expect(JSON.parse(store.get(SKIPS_KEY)!)).toEqual(["a"]);
    expect(store.get(deviceSkipKey("a"))).toBe("1");
  });

  it("a text off the account's list stays quiet on this device", () => {
    store.set(deviceSkipKey("old"), "1");
    expect(readSkipped("old")).toBe(true);
  });

  it("an old no on this device is carried to the account, once", () => {
    store.set(deviceSkipKey("old"), "1");
    carryDeviceSkip("old");
    carryDeviceSkip("old");
    carryDeviceSkip("never-declined");
    expect(JSON.parse(store.get(SKIPS_KEY)!)).toEqual(["old"]);
  });

  it("junk on the device reads as no list", () => {
    store.set(SKIPS_KEY, "{not json");
    expect(readSkipped("a")).toBe(false);
  });

  it("storage that throws: on, not skipped, and writing does not throw", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("private window");
      },
    });
    expect(readOfferOn()).toBe(true);
    expect(readSkipped("a")).toBe(false);
    expect(() => writeSkip("a")).not.toThrow();
  });
});

describe("the speech draft's choice", () => {
  const raw = { source: "paste", shape: { raw: true } } as never;
  it("is for who may polish, on a raw text, a Google Doc or a tidied text", () => {
    expect(draftChoiceShown(raw, true)).toBe(true);
    expect(draftChoiceShown(raw, false)).toBe(false);
    expect(draftChoiceShown({ source: "gdoc" } as never, true)).toBe(true);
    expect(
      draftChoiceShown(
        { source: "paste", polished: { at: "", chunks: 1, kept: 1 } } as never,
        true,
      ),
    ).toBe(true);
    expect(draftChoiceShown({ source: "paste" } as never, true)).toBe(false);
    expect(draftChoiceShown(null, true)).toBe(false);
  });
  it("is never offered on a /vibe conversation", () => {
    expect(draftChoiceShown({ source: "vibe", shape: { raw: true } } as never, true)).toBe(false);
  });
});
