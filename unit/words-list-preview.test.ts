import { describe, expect, test } from "bun:test";
import { previewLoader, previewSize, windowOf, type PreviewEntry } from "@/lib/words/list-preview";

const e = (term: string): PreviewEntry => ({ term, back: `${term}-m` });
const src = (id: string, count = 2) => ({ id, count, path: `/w/${id}.json` });

describe("previewLoader", () => {
  test("loads nothing until asked, then one list per call, in order", async () => {
    const calls: string[] = [];
    const files: Record<string, PreviewEntry[]> = {
      "/w/a.json": [e("x"), e("y")],
      "/w/b.json": [e("z")],
    };
    const l = previewLoader([src("a"), src("b")], async (p) => {
      calls.push(p);
      return files[p];
    });
    expect(calls).toEqual([]);
    expect(l.state.done).toBe(false);
    let s = await l.more();
    expect(calls).toEqual(["/w/a.json"]);
    expect(s.rows.map((r) => [r.term, r.listId])).toEqual([
      ["x", "a"],
      ["y", "a"],
    ]);
    s = await l.more();
    expect(s.rows.map((r) => r.term)).toEqual(["x", "y", "z"]);
    expect(s.done).toBe(true);
    await l.more();
    expect(calls).toHaveLength(2);
  });

  test("a band reads as one list: a term from an earlier list is not repeated", async () => {
    const l = previewLoader([src("a"), src("b")], async (p) =>
      p.includes("a") ? [e("x"), e("y")] : [e("y"), e("z")],
    );
    await l.more();
    const s = await l.more();
    expect(s.rows.map((r) => r.term)).toEqual(["x", "y", "z"]);
  });

  test("concurrent calls share one load", async () => {
    let n = 0;
    const l = previewLoader([src("a")], async () => {
      n++;
      return [e("x")];
    });
    const [a, b] = await Promise.all([l.more(), l.more()]);
    expect(n).toBe(1);
    expect(a).toBe(b);
  });

  test("a failure is kept and the same list is tried again", async () => {
    let fail = true;
    const l = previewLoader([src("a")], async () => {
      if (fail) throw new Error("offline");
      return [e("x")];
    });
    let s = await l.more();
    expect(s.error).toBe("offline");
    expect(s.done).toBe(false);
    fail = false;
    s = await l.more();
    expect(s.error).toBeUndefined();
    expect(s.rows.map((r) => r.term)).toEqual(["x"]);
    expect(s.done).toBe(true);
  });

  test("no sources is done at once", () => {
    expect(previewLoader([], async () => []).state.done).toBe(true);
  });

  test("previewSize sums the stated counts", () => {
    expect(previewSize([src("a", 500), src("b", 500)])).toBe(1000);
  });
});

describe("windowOf", () => {
  test("renders only rows near the view, keeping the rest as space", () => {
    const w = windowOf(10_000, [], 50, 5000, 500, 100);
    expect(w.start).toBe(98);
    expect(w.end).toBe(112);
    expect(w.before).toBe(98 * 50);
    expect(w.before + (w.end - w.start) * 50 + w.after).toBe(10_000 * 50);
  });

  test("uses measured heights where known", () => {
    const heights = [100, 100, 100];
    const w = windowOf(10, heights, 50, 250, 100, 0);
    expect(w.start).toBe(2);
    expect(w.before).toBe(200);
  });

  test("top of the list and empty lists", () => {
    expect(windowOf(3, [], 50, 0, 1000, 0)).toEqual({ start: 0, end: 3, before: 0, after: 0 });
    expect(windowOf(0, [], 50, 0, 1000, 0)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  });
});
