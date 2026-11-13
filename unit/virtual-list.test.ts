import { describe, expect, test } from "bun:test";
import {
  anchorMoved,
  anchorStoreName,
  centreDelta,
  centreIndex,
  keyTarget,
  mergeBatch,
  offsetFor,
  PREFETCH_ROWS,
  PREFETCH_SCREENS,
  RESERVE_SCREENS,
  reserveBelow,
  RESTORE_MAX_BATCHES,
  restoreStep,
  setSize,
  shouldLoadMore,
} from "@/lib/virtual-list";
import { CONFIG } from "@/lib/config";

// Rows of 100 px starting at 200 (the list begins 200 px down the page).
const rows = [0, 1, 2, 3, 4].map((i) => ({ index: i, start: 200 + i * 100, end: 300 + i * 100 }));

describe("centre row", () => {
  test("the row under the viewport's centre line", () => {
    // viewport 400 at offset 0: centre 200 → row 0 (starts at 200).
    expect(centreIndex(rows, 0, 400)).toBe(0);
    // offset 150: centre 350 → row 1 (300–400).
    expect(centreIndex(rows, 150, 400)).toBe(1);
    // exactly on a boundary: the lower row.
    expect(centreIndex(rows, 200, 400)).toBe(2);
  });

  test("above the list: nothing; past the end: the last row; no rows: nothing", () => {
    expect(centreIndex(rows, 0, 200)).toBeNull();
    expect(centreIndex(rows, 5000, 400)).toBe(4);
    expect(centreIndex([], 0, 400)).toBeNull();
  });

  test("the offset within the row survives a move", () => {
    const d = centreDelta(rows[1], 150, 400); // centre 350, row starts 300
    expect(d).toBe(50);
    // The row moved down 300 px (three rows inserted above): same place on screen.
    expect(offsetFor(600, d, 400)).toBe(450);
    expect(offsetFor(0, 0, 400)).toBe(0);
  });
});

describe("loading more", () => {
  const base = { count: 30, hasMore: true, loading: false, error: false, asked: null };
  test("near the end, once per length", () => {
    expect(shouldLoadMore({ ...base, lastIndex: 29 - PREFETCH_ROWS })).toBe(true);
    expect(shouldLoadMore({ ...base, lastIndex: 10 })).toBe(false);
    expect(shouldLoadMore({ ...base, lastIndex: 29, asked: 30 })).toBe(false);
    expect(shouldLoadMore({ ...base, lastIndex: 25, prefetch: 2 })).toBe(false);
  });
  test("two screens before the end by distance, even far from the last rows", () => {
    expect(
      shouldLoadMore({ ...base, lastIndex: 10, belowPx: 800 * PREFETCH_SCREENS, viewportPx: 800 }),
    ).toBe(true);
    expect(
      shouldLoadMore({
        ...base,
        lastIndex: 10,
        belowPx: 800 * PREFETCH_SCREENS + 1,
        viewportPx: 800,
      }),
    ).toBe(false);
    expect(shouldLoadMore({ ...base, lastIndex: 10, belowPx: 0, viewportPx: 0 })).toBe(false);
  });
  test("space kept below while more may come, none at the end", () => {
    expect(reserveBelow(true, 800)).toBe(Math.round(800 * RESERVE_SCREENS));
    expect(reserveBelow(false, 800)).toBe(0);
    expect(reserveBelow(true, 0)).toBe(0);
  });
  test("never while loading, after an error, or with no more", () => {
    expect(shouldLoadMore({ ...base, lastIndex: 29, loading: true })).toBe(false);
    expect(shouldLoadMore({ ...base, lastIndex: 29, error: true })).toBe(false);
    expect(shouldLoadMore({ ...base, lastIndex: 29, hasMore: false })).toBe(false);
  });
  test("an empty list asks at once; rows not laid out yet do not", () => {
    expect(shouldLoadMore({ ...base, count: 0, lastIndex: null })).toBe(true);
    expect(shouldLoadMore({ ...base, lastIndex: null })).toBe(false);
  });
});

describe("restoring by id", () => {
  const s = {
    keys: ["a", "b", "c"],
    id: "c",
    hasMore: true,
    loading: false,
    error: false,
    batches: 0,
  };
  test("found: scroll to it", () => {
    expect(restoreStep(s)).toEqual({ do: "scroll", index: 2 });
  });
  test("not loaded yet: load, or wait for the batch on its way", () => {
    expect(restoreStep({ ...s, id: "z" })).toEqual({ do: "load" });
    expect(restoreStep({ ...s, id: "z", loading: true })).toEqual({ do: "wait" });
  });
  test("gone, failed or too far: give up", () => {
    expect(restoreStep({ ...s, id: "z", hasMore: false })).toEqual({ do: "give-up" });
    expect(restoreStep({ ...s, id: "z", error: true })).toEqual({ do: "give-up" });
    expect(restoreStep({ ...s, id: "z", batches: RESTORE_MAX_BATCHES })).toEqual({
      do: "give-up",
    });
  });
  test("the store name", () => {
    expect(anchorStoreName("reader")).toBe("list:reader");
  });
  test("an insert above moves the anchor; appending below does not", () => {
    expect(anchorMoved(["a", "b"], ["n", "a", "b"], "b")).toBe(2);
    expect(anchorMoved(["a", "b"], ["a", "b", "c"], "b")).toBeNull();
    expect(anchorMoved(["a", "b"], ["a"], "b")).toBeNull();
    expect(anchorMoved([], ["a"], "a")).toBeNull();
  });
});

describe("keyboard", () => {
  test("arrows, pages, ends, clamped", () => {
    expect(keyTarget("ArrowDown", 3, 10, 5)).toBe(4);
    expect(keyTarget("ArrowUp", 0, 10, 5)).toBe(0);
    expect(keyTarget("PageDown", 3, 10, 5)).toBe(7);
    expect(keyTarget("PageUp", 3, 10, 5)).toBe(0);
    expect(keyTarget("PageDown", 3, 10, 1)).toBe(4);
    expect(keyTarget("Home", 6, 10, 5)).toBe(0);
    expect(keyTarget("End", 0, 10, 5)).toBe(9);
    expect(keyTarget("ArrowDown", 9, 10, 5)).toBe(9);
  });
  test("other keys and empty lists: not ours", () => {
    expect(keyTarget("Enter", 1, 10, 5)).toBeNull();
    expect(keyTarget("ArrowDown", 0, 0, 5)).toBeNull();
  });
});

describe("aria-setsize and batches", () => {
  test("known total, unknown while more may load, else the count", () => {
    expect(setSize(10, true, 42)).toBe(42);
    expect(setSize(10, true, 3)).toBe(-1); // a stale total below the count is ignored
    expect(setSize(10, true)).toBe(-1);
    expect(setSize(10, false, null)).toBe(10);
  });
  test("overlapping batches are joined without duplicates", () => {
    const k = (x: { id: string }) => x.id;
    const out = mergeBatch([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }, { id: "c" }], k);
    expect(out.map(k)).toEqual(["a", "b", "c"]);
  });
  test("the batch size is a config key, not a page size", () => {
    const d = CONFIG["lists.batchSize"];
    expect(d.audience).toBe("public");
    expect(d.schema.safeParse(d.default).success).toBe(true);
    expect(d.schema.safeParse(1000).success).toBe(false);
  });
});
