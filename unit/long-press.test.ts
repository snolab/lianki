import { describe, expect, it } from "bun:test";
import { createLongPress, LONG_PRESS_MS } from "@lianki/debug-chat/long-press";

function clock() {
  let t: { f: () => void; ms: number } | null = null;
  return {
    setTimer: (f: () => void, ms: number) => (t = { f, ms }),
    clearTimer: () => void (t = null),
    fire: () => {
      const x = t;
      t = null;
      x?.f();
    },
    get pending() {
      return t;
    },
  };
}

describe("createLongPress", () => {
  it("fires once a press is held still, and says so once", () => {
    const c = clock();
    let n = 0;
    const lp = createLongPress({ onLong: () => n++, ...c });
    lp.down(0, 0);
    expect(c.pending?.ms).toBe(LONG_PRESS_MS);
    lp.move(3, 4); // 5 px: still held
    c.fire();
    expect(n).toBe(1);
    expect(lp.fired()).toBe(true);
    expect(lp.fired()).toBe(false);
  });

  it("a move past the slop, an up or a cancel ends it", () => {
    const c = clock();
    let n = 0;
    const lp = createLongPress({ onLong: () => n++, ms: 300, slopPx: 4, ...c });
    lp.down(0, 0);
    expect(c.pending?.ms).toBe(300);
    lp.move(5, 0);
    expect(c.pending).toBeNull();
    lp.move(50, 0); // no press: nothing
    lp.down(0, 0);
    lp.cancel();
    expect(c.pending).toBeNull();
    expect(n).toBe(0);
    expect(lp.fired()).toBe(false);
  });

  it("a new press forgets the last one's fire; real timers work", async () => {
    let n = 0;
    const lp = createLongPress({ onLong: () => n++, ms: 5 });
    lp.down(0, 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(n).toBe(1);
    lp.down(0, 0);
    expect(lp.fired()).toBe(false);
    lp.cancel();
  });
});
