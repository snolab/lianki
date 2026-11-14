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
  anchorIndexStoreName,
  isPlaceholderKey,
  loadDelay,
  loadedCount,
  missingPages,
  OVERSCAN_PAGES,
  pageOf,
  pagesToFetch,
  placeholderKey,
  putPage,
  RANGE_SETTLE_MS,
  removeWhere,
  sparseRestoreStep,
  stalePages,
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
    const at = { hasMore: true, viewport: 800, count: 30, rowPx: 50 };
    expect(reserveBelow({ ...at, total: 1030 })).toBe(1000 * 50);
    expect(reserveBelow({ ...at, total: null })).toBe(800 * RESERVE_SCREENS);
    expect(reserveBelow({ ...at, total: 30 })).toBe(800 * RESERVE_SCREENS);
    expect(reserveBelow({ ...at, hasMore: false, total: 1030 })).toBe(0);
    expect(reserveBelow({ ...at, viewport: 0 })).toBe(0);
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

describe("random access: which pages to fetch", () => {
  const none = () => false;
  test("the pages in view first, then about one page around them", () => {
    // 30 per page, 1000 rows; rows 300–340 in view → pages 10, 11, then 12 and 9.
    expect(missingPages({ from: 300, to: 340, size: 30, total: 1000, has: none })).toEqual([
      10, 11, 12, 9,
    ]);
    expect(
      missingPages({ from: 300, to: 340, size: 30, total: 1000, has: none, overscanPages: 0 }),
    ).toEqual([10, 11]);
    expect(OVERSCAN_PAGES).toBe(1);
  });
  test("a far fling asks only for where it landed, nothing in between", () => {
    const loaded = new Set(Array.from({ length: 60 }, (_, i) => i)); // pages 0–1 in
    const pages = missingPages({
      from: 9000,
      to: 9020,
      size: 30,
      total: 10000,
      has: (i) => loaded.has(i),
    });
    expect(pages).toEqual([300, 301, 299]);
  });
  test("loaded pages are skipped; one missing row makes its page wanted", () => {
    const has = (i: number) => i !== 45;
    expect(missingPages({ from: 0, to: 20, size: 30, total: 90, has })).toEqual([1]);
    expect(missingPages({ from: 0, to: 20, size: 30, total: 90, has: () => true })).toEqual([]);
  });
  test("clamped to the list: no page before 0, none past the last row", () => {
    expect(missingPages({ from: 0, to: 5, size: 30, total: 40, has: none })).toEqual([0, 1]);
    expect(missingPages({ from: 35, to: 999, size: 30, total: 40, has: none })).toEqual([1, 0]);
    // The last page is short: its rows past the total are not wanted.
    expect(missingPages({ from: 30, to: 39, size: 30, total: 40, has: (i) => i >= 30 })).toEqual([
      0,
    ]);
  });
  test("nothing for an empty list, a bad page size or an empty range", () => {
    expect(missingPages({ from: 0, to: 5, size: 30, total: 0, has: none })).toEqual([]);
    expect(missingPages({ from: 0, to: 5, size: 0, total: 10, has: none })).toEqual([]);
    expect(missingPages({ from: 5, to: 4, size: 30, total: 10, has: none })).toEqual([]);
  });
  test("the page of an index", () => {
    expect(pageOf(0, 30)).toBe(0);
    expect(pageOf(29, 30)).toBe(0);
    expect(pageOf(30, 30)).toBe(1);
    expect(pageOf(-5, 30)).toBe(0);
    expect(pageOf(10, 0)).toBe(0);
  });
});

describe("random access: when and what to ask", () => {
  test("at rest at once; while moving, once the wanted pages hold still", () => {
    expect(loadDelay(false)).toBe(0);
    expect(loadDelay(true)).toBe(RANGE_SETTLE_MS);
    expect(RANGE_SETTLE_MS).toBe(120);
  });
  test("never the same page twice in flight", () => {
    expect(pagesToFetch([3, 4, 4, 5, -1], new Set([4]))).toEqual([3, 5]);
    expect(pagesToFetch([], new Set())).toEqual([]);
  });
  test("requests the reader flung past are cancelled", () => {
    expect(stalePages(new Set([1, 5, 9, 12]), { from: 4, to: 10 })).toEqual([1, 12]);
    expect(stalePages([], { from: 0, to: 1 })).toEqual([]);
  });
});

describe("random access: the sparse rows", () => {
  test("a page goes in place; holes stay holes", () => {
    const a = putPage<string>([], 2, 3, ["g", "h", "i"]);
    expect(a.length).toBe(9);
    expect(loadedCount(a)).toBe(3);
    expect(a[6]).toBe("g");
    expect(0 in a).toBe(false);
    const b = putPage(a, 0, 3, ["a", "b"]);
    expect(loadedCount(b)).toBe(5);
    expect(loadedCount(a)).toBe(3); // a new array
  });
  test("a delete moves later rows up, as the server's offsets move", () => {
    const rows = putPage(putPage<string>([], 0, 3, ["a", "b", "c"]), 2, 3, ["g", "h", "i"]);
    const r = removeWhere(rows, (x) => x === "b" || x === "h");
    expect(r.removed).toBe(2);
    expect(r.rows.length).toBe(7);
    expect(r.rows[0]).toBe("a");
    expect(r.rows[1]).toBe("c");
    expect(2 in r.rows).toBe(false);
    expect(r.rows[5]).toBe("g");
    expect(r.rows[6]).toBe("i");
  });
  test("placeholder keys and the index's store name", () => {
    expect(isPlaceholderKey(placeholderKey(7))).toBe(true);
    expect(isPlaceholderKey("https://example.com/7")).toBe(false);
    expect(anchorIndexStoreName("data-cloud")).toBe("list:data-cloud:at");
  });
});

describe("random access: restoring", () => {
  const s = {
    keys: [] as (string | undefined)[],
    id: "u" as string | null,
    at: 500 as number | null,
    total: 1000 as number | null,
    loadedAt: false,
    jumped: false,
    error: false,
  };
  test("the id when it is loaded", () => {
    const keys: (string | undefined)[] = [];
    keys[480] = "u";
    expect(sparseRestoreStep({ ...s, keys })).toEqual({ do: "scroll", index: 480, done: true });
  });
  test("straight to the index, then wait for its page", () => {
    expect(sparseRestoreStep(s)).toEqual({ do: "scroll", index: 500, done: false });
    expect(sparseRestoreStep({ ...s, jumped: true })).toEqual({ do: "wait" });
    expect(sparseRestoreStep({ ...s, total: null })).toEqual({ do: "wait" });
    // The list got shorter since: its last row.
    expect(sparseRestoreStep({ ...s, total: 100 })).toEqual({
      do: "scroll",
      index: 99,
      done: false,
    });
  });
  test("its page is in but the id is not on it: stay at the index", () => {
    expect(sparseRestoreStep({ ...s, loadedAt: true })).toEqual({
      do: "scroll",
      index: 500,
      done: true,
    });
  });
  test("nothing to go back to: give up", () => {
    expect(sparseRestoreStep({ ...s, error: true })).toEqual({ do: "give-up" });
    expect(sparseRestoreStep({ ...s, at: null })).toEqual({ do: "give-up" });
    expect(sparseRestoreStep({ ...s, id: null, at: -1 })).toEqual({ do: "give-up" });
    expect(sparseRestoreStep({ ...s, total: 0 })).toEqual({ do: "give-up" });
  });
});
