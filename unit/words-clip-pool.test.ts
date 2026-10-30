import { describe, expect, test } from "bun:test";
import { createClipPool, type ElementLike } from "../lib/words/clip-pool";

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
  end() {
    this.paused = true;
    this.ended = true;
    this.onended?.(new Event("ended"));
  }
}

function setup(max?: number) {
  const els: FakeEl[] = [];
  let sources = 0;
  const gains: { calls: string[] }[] = [];
  const timers: (() => void)[] = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain() {
      const calls: string[] = [];
      gains.push({ calls });
      return {
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
      sources++;
      return { connect: (n: unknown) => n };
    },
  };
  const pool = createClipPool({
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
  return { pool, els, gains, timers, sources: () => sources };
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
