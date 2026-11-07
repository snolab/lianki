import { describe, expect, test } from "bun:test";
import { createLeaving, pageLeaving } from "../lib/page-leaving";

function fakeWindow() {
  const on = new Map<string, Set<() => void>>();
  return {
    addEventListener: (t: string, f: () => void) => {
      if (!on.has(t)) on.set(t, new Set());
      on.get(t)!.add(f);
    },
    removeEventListener: (t: string, f: () => void) => void on.get(t)?.delete(f),
    fire: (t: string) => on.get(t)?.forEach((f) => f()),
    count: () => [...on.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("page leaving", () => {
  test("beforeunload aborts the signal; a pointer, a key or a restored page brings it back", () => {
    const w = fakeWindow();
    const l = createLeaving(w as never);
    const release = l.watch();
    expect(l.signal.aborted).toBe(false);
    w.fire("beforeunload");
    const cut = l.signal;
    expect(cut.aborted).toBe(true);
    // Timers and effects keep running while the next page loads: still left.
    expect(l.signal.aborted).toBe(true);
    for (const back of ["pointerdown", "keydown", "pageshow"]) {
      w.fire("beforeunload");
      expect(l.signal.aborted).toBe(true);
      w.fire(back);
      expect(l.signal.aborted).toBe(false);
    }
    expect(cut.aborted).toBe(true);
    release();
  });

  test("listens only while held, and lets go once per holder", () => {
    const w = fakeWindow();
    const l = createLeaving(w as never);
    expect(w.count()).toBe(0);
    const a = l.watch();
    const b = l.watch();
    expect(w.count()).toBe(4);
    a();
    a();
    expect(w.count()).toBe(4);
    w.fire("beforeunload");
    b();
    expect(w.count()).toBe(0);
    // Nobody listening: nothing is left over for the next holder.
    expect(l.signal.aborted).toBe(false);
  });

  test("pageLeaving is one per window", () => {
    const w = fakeWindow();
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    const prev = g.window;
    g.window = w;
    try {
      const a = pageLeaving();
      expect(pageLeaving()).toBe(a);
      const release = a.watch();
      expect(w.count()).toBe(4);
      release();
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
  });
});
