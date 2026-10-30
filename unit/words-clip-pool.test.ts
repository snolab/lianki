import { describe, expect, test } from "bun:test";
import { createClipPool, spareCount, type ElementLike } from "../lib/words/clip-pool";

/** A fake <audio>: play() unpauses, end() plays it out. */
class FakeEl implements ElementLike {
  src = "";
  paused = true;
  ended = false;
  onended: ((ev: Event) => void) | null = null;
  onerror: unknown = null;
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    this.ended = false;
    return Promise.resolve();
  }
  srcRemoved = 0;
  loads = 0;
  removeAttribute(name: string) {
    if (name === "src") {
      this.src = "";
      this.srcRemoved++;
    }
  }
  load() {
    this.loads++;
  }
  end() {
    this.paused = true;
    this.ended = true;
    this.onended?.(new Event("ended"));
  }
}

function setup(max?: number) {
  const els: FakeEl[] = [];
  let sources = 0;
  /** Every node's disconnect, in order: "source 0", "gain 0", … */
  const disconnects: string[] = [];
  const gains: { calls: string[] }[] = [];
  const timers: (() => void)[] = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain() {
      const calls: string[] = [];
      const i = gains.length;
      gains.push({ calls });
      return {
        disconnect: () => void disconnects.push(`gain ${i}`),
        gain: {
          value: 1,
          cancelScheduledValues: () => void calls.push("cancel"),
          setValueAtTime: (v: number) => void calls.push(`set ${v}`),
          linearRampToValueAtTime: (v: number) => void calls.push(`ramp ${v}`),
        },
        connect: (n: unknown) => n,
      };
    },
    createMediaElementSource() {
      const i = sources++;
      return {
        connect: (n: unknown) => n,
        disconnect: () => void disconnects.push(`source ${i}`),
      };
    },
  };
  /** A pool on this context; `next()` makes another, as a hot swap would. */
  const make = () =>
    createClipPool({
      element: () => {
        const e = new FakeEl();
        els.push(e);
        return e;
      },
      ctx: () => ctx,
      max,
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (t) => {
        timers[(t as unknown as number) - 1] = () => {};
      },
    });
  const pool = make();
  return { pool, next: make, ctx, els, gains, timers, disconnects, sources: () => sources };
}

describe("word clip pool", () => {
  test("a thousand clips played one after another use one element and one source node", () => {
    const { pool, sources } = setup();
    for (let i = 0; i < 1000; i++) {
      const c = pool.take(`blob:${i}`);
      void c.el.play();
      (c.el as FakeEl).end();
    }
    expect(pool.size()).toBe(1);
    expect(sources()).toBe(1);
  });

  test("a clip fading out is not reused until its fade ends", () => {
    const { pool, timers } = setup();
    const a = pool.take("blob:a");
    void a.el.play();
    pool.fadeOut(a, 0.15);
    const b = pool.take("blob:b");
    expect(b.el).not.toBe(a.el);
    void b.el.play();
    timers.forEach((t) => t()); // a's fade ends: a is paused and idle again
    expect(a.el.paused).toBe(true);
    (b.el as FakeEl).end();
    expect(pool.take("blob:c").el).toBe(a.el);
    expect(pool.size()).toBe(2);
  });

  test("a reused element starts at full volume, with the new source", () => {
    const { pool, gains, timers } = setup();
    const a = pool.take("blob:a");
    void a.el.play();
    pool.fadeOut(a, 0.15);
    timers.forEach((t) => t());
    gains[0].calls.length = 0;
    const again = pool.take("blob:b");
    expect(again.el).toBe(a.el);
    expect(again.el.src).toBe("blob:b");
    expect(gains[0].calls).toEqual(["cancel", "set 1"]);
  });

  test("never more than max elements: the oldest busy one is stopped and taken", () => {
    const { pool, els } = setup(2);
    const a = pool.take("blob:a");
    void a.el.play();
    let doneA = false;
    a.el.onended = () => void (doneA = true);
    const b = pool.take("blob:b");
    void b.el.play();
    const c = pool.take("blob:c");
    expect(els.length).toBe(2);
    expect(c.el).toBe(a.el);
    expect(a.el.paused).toBe(true);
    expect(a.el.onended).toBeNull();
    expect(doneA).toBe(false);
  });

  test("a stale fade timer never pauses the element's next clip", () => {
    const { pool, timers } = setup(1);
    const a = pool.take("blob:a");
    void a.el.play();
    pool.fadeOut(a, 0.15);
    const b = pool.take("blob:b"); // the only element: taken mid-fade, its timer cleared
    void b.el.play();
    timers.forEach((t) => t());
    expect(b.el.paused).toBe(false);
  });

  test("without Web Audio, elements still play and fadeOut stops at once", () => {
    const pool = createClipPool({ element: () => new FakeEl(), ctx: () => null });
    const a = pool.take("blob:a");
    void a.el.play();
    pool.fadeOut(a, 0.15);
    expect(a.el.paused).toBe(true);
    expect(a.gain).toBeNull();
  });
});

describe("word clip pool: dispose", () => {
  test("stops every clip, disconnects source then gain, and empties each element", () => {
    const { pool, els, disconnects, timers } = setup(3);
    const a = pool.take("blob:a");
    void a.el.play();
    let doneA = false;
    a.el.onended = () => void (doneA = true);
    const b = pool.take("blob:b");
    void b.el.play();
    pool.fadeOut(b, 0.15); // mid-fade at dispose: its timer must not fire later
    pool.dispose();
    expect(pool.disposed).toBe(true);
    expect(pool.size()).toBe(0);
    expect(els.every((e) => e.paused)).toBe(true);
    expect(els.every((e) => e.onended === null && e.onerror === null)).toBe(true);
    expect(els.map((e) => [e.srcRemoved, e.loads])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(els.every((e) => e.src === "")).toBe(true);
    expect(disconnects).toEqual(["source 0", "gain 0", "source 1", "gain 1"]);
    expect(a.source).toBeNull();
    expect(a.gain).toBeNull();
    expect(b.fading).toBeNull();
    timers.forEach((t) => t());
    expect(doneA).toBe(false);
  });

  test("after dispose, take makes no element and no node, and its clip reports not played", async () => {
    const { pool, els, sources } = setup();
    pool.take("blob:a");
    pool.dispose();
    const c = pool.take("blob:b");
    expect(els.length).toBe(1);
    expect(sources()).toBe(1);
    expect(pool.size()).toBe(0);
    let failed = false;
    c.el.onerror = () => void (failed = true);
    await c.el.play();
    await Promise.resolve();
    expect(failed).toBe(true);
    expect(c.el.paused).toBe(true);
  });

  test("after dispose, fadeOut of an old clip does nothing; dispose twice is harmless", () => {
    const { pool, gains, timers, disconnects } = setup();
    const a = pool.take("blob:a");
    void a.el.play();
    pool.dispose();
    void a.el.play(); // the caller still holds it
    gains[0].calls.length = 0;
    pool.fadeOut(a, 0.15);
    expect(gains[0].calls).toEqual([]);
    expect(timers.length).toBe(0);
    pool.dispose();
    expect(disconnects).toEqual(["source 0", "gain 0"]);
  });

  test("the next pool on the context adopts the disposed pool's wired elements", () => {
    const { pool, next, ctx, els, gains, sources } = setup();
    const a = pool.take("blob:a");
    void a.el.play();
    const b = pool.take("blob:b");
    void b.el.play();
    expect(pool.size()).toBe(2);
    pool.dispose();
    expect(spareCount(ctx)).toBe(2);

    const p2 = next();
    const c = p2.take("blob:c");
    void c.el.play();
    const e = p2.take("blob:e");
    void e.el.play();
    // The same two elements and source nodes; each gets a fresh gain.
    expect(els.length).toBe(2);
    expect(sources()).toBe(2);
    expect(new Set([c.el, e.el])).toEqual(new Set([a.el, b.el]));
    expect(gains.length).toBe(4);
    expect(spareCount(ctx)).toBe(0);
    // Past the spares it makes new ones as usual.
    void p2.take("blob:f").el.play();
    expect(els.length).toBe(3);
  });

  test("a hundred pools, each disposed in turn, never make more than one pool's elements", () => {
    const { pool, next, ctx, els, sources } = setup(4);
    let p = pool;
    for (let i = 0; i < 100; i++) {
      for (let k = 0; k < 4; k++) void p.take(`blob:${i}.${k}`).el.play();
      p.dispose();
      p = next();
    }
    expect(els.length).toBe(4);
    expect(sources()).toBe(4);
    expect(spareCount(ctx)).toBe(4);
  });

  test("a node that throws while being released does not stop the rest", () => {
    const els: FakeEl[] = [];
    const boom = () => {
      throw new Error("InvalidAccessError");
    };
    const ctx = {
      currentTime: 0,
      destination: {},
      createGain: () => ({
        gain: {
          value: 1,
          cancelScheduledValues() {},
          setValueAtTime() {},
          linearRampToValueAtTime() {},
        },
        connect: (n: unknown) => n,
        disconnect: boom,
      }),
      createMediaElementSource: () => ({ connect: (n: unknown) => n, disconnect: boom }),
    };
    const pool = createClipPool({
      element: () => {
        const e = new FakeEl();
        els.push(e);
        return e;
      },
      ctx: () => ctx,
    });
    void pool.take("blob:a").el.play();
    void pool.take("blob:b").el.play();
    expect(() => pool.dispose()).not.toThrow();
    expect(els.map((e) => e.loads)).toEqual([1, 1]);
  });

  test("without Web Audio, dispose still stops and empties the elements", () => {
    const els: FakeEl[] = [];
    const pool = createClipPool({
      element: () => {
        const e = new FakeEl();
        els.push(e);
        return e;
      },
      ctx: () => null,
    });
    void pool.take("blob:a").el.play();
    pool.dispose();
    expect(els[0].paused).toBe(true);
    expect(els[0].srcRemoved).toBe(1);
  });
});

test("with the real timers, a fade ends and its element is idle again", async () => {
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain: () => ({
      gain: {
        value: 1,
        cancelScheduledValues() {},
        setValueAtTime() {},
        linearRampToValueAtTime() {},
      },
      connect: (n: unknown) => n,
    }),
    createMediaElementSource: () => ({ connect: (n: unknown) => n }),
  };
  const pool = createClipPool({ element: () => new FakeEl(), ctx: () => ctx, max: 1 });
  const a = pool.take("blob:a");
  void a.el.play();
  pool.fadeOut(a, 0);
  expect(a.fading).not.toBeNull();
  await new Promise((r) => setTimeout(r, 60));
  expect(a.el.paused).toBe(true);
  expect(a.fading).toBeNull();
  void pool.take("blob:b").el.play();
  pool.fadeOut(a, 0.5);
  pool.take("blob:c"); // mid-fade: the fade's timer is cleared
  expect(a.fading).toBeNull();
});
