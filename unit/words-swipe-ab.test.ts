import { describe, expect, test } from "bun:test";
import {
  SWIPE_AB_KEY,
  setSwipeVariant,
  swipeAbTag,
  swipeOverride,
  swipeVariant,
} from "@/lib/words/swipe-ab";

/** An in-memory Storage that records every write. */
function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  const writes: [string, string][] = [];
  return {
    writes,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push([k, v]);
      m.set(k, v);
    },
  };
}

describe("swipe A/B variant", () => {
  test("stored choice, default js", () => {
    expect(swipeVariant(memStore(), "")).toBe("js");
    expect(swipeVariant(memStore({ [SWIPE_AB_KEY]: "native" }), "")).toBe("native");
  });

  test("?swipe= overrides the stored choice either way", () => {
    expect(swipeVariant(memStore({ [SWIPE_AB_KEY]: "js" }), "?swipe=native")).toBe("native");
    expect(swipeVariant(memStore({ [SWIPE_AB_KEY]: "native" }), "?embed=1&swipe=js")).toBe("js");
    expect(swipeOverride("?swipe=bogus")).toBeNull();
    expect(swipeVariant(memStore({ [SWIPE_AB_KEY]: "native" }), "?swipe=bogus")).toBe("native");
  });

  test("the override is never written to storage", () => {
    const store = memStore({ [SWIPE_AB_KEY]: "js" });
    expect(swipeVariant(store, "?swipe=native")).toBe("native");
    // The telemetry tag reads the override, but writes only the device id.
    expect(swipeAbTag(store, () => 0.5)).toMatch(/^ab=(js|native);dev=/);
    expect(store.writes.filter(([k]) => k === SWIPE_AB_KEY)).toEqual([]);
    expect(store.getItem(SWIPE_AB_KEY)).toBe("js");
    // Only the Settings switch writes it.
    setSwipeVariant("native", store);
    expect(store.getItem(SWIPE_AB_KEY)).toBe("native");
  });
});
