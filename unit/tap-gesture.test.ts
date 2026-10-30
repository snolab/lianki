import { describe, expect, it } from "bun:test";
import {
  DOUBLE_TAP_MS,
  DRAG_CLICK_MS,
  createDragFlag,
  createTapper,
} from "@lianki/debug-chat/tap-gesture";

/** Fake timers: `advance(ms)` runs what falls due. */
function clock() {
  let now = 0;
  let timers: { at: number; f: () => void; live: boolean }[] = [];
  return {
    setTimer: (f: () => void, ms: number) => {
      const t = { at: now + ms, f, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t: unknown) => {
      (t as { live: boolean }).live = false;
    },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.live && t.at <= now);
      timers = timers.filter((t) => !due.includes(t));
      for (const t of due) {
        t.live = false;
        t.f();
      }
    },
  };
}

function setup() {
  const c = clock();
  const did: string[] = [];
  const tapper = createTapper({
    onSingle: () => did.push("single"),
    onDouble: () => did.push("double"),
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  return { c, did, tapper };
}

describe("createTapper: single vs double tap", () => {
  it("a single tap acts after the delay, not before", () => {
    const { c, did, tapper } = setup();
    tapper.tap();
    c.advance(DOUBLE_TAP_MS - 1);
    expect(did).toEqual([]);
    c.advance(1);
    expect(did).toEqual(["single"]);
  });

  it("a second tap inside the window is a double tap, and the single never fires", () => {
    const { c, did, tapper } = setup();
    tapper.tap();
    c.advance(150);
    tapper.tap();
    expect(did).toEqual(["double"]);
    c.advance(1_000);
    expect(did).toEqual(["double"]);
  });

  it("two taps further apart are two singles; a third tap starts afresh", () => {
    const { c, did, tapper } = setup();
    tapper.tap();
    c.advance(DOUBLE_TAP_MS);
    tapper.tap();
    c.advance(DOUBLE_TAP_MS);
    expect(did).toEqual(["single", "single"]);
    tapper.tap();
    tapper.tap();
    tapper.tap();
    c.advance(DOUBLE_TAP_MS);
    expect(did).toEqual(["single", "single", "double", "single"]);
  });

  it("cancel drops a waiting single tap", () => {
    const { c, did, tapper } = setup();
    tapper.tap();
    tapper.cancel();
    tapper.cancel();
    c.advance(1_000);
    expect(did).toEqual([]);
  });

  it("real timers and a custom delay", async () => {
    const did: string[] = [];
    const t = createTapper({ onSingle: () => did.push("s"), onDouble: () => {}, delayMs: 1 });
    t.tap();
    await new Promise((r) => setTimeout(r, 10));
    expect(did).toEqual(["s"]);
    t.tap();
    t.tap();
    t.tap();
    t.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(did).toEqual(["s"]);
  });
});

describe("createDragFlag: the click after a drag", () => {
  it("the click that ends a drag is not a tap; the next one is", () => {
    let t = 0;
    const f = createDragFlag(() => t);
    f.down();
    f.dragEnded();
    expect(f.wasDrag()).toBe(true);
    f.down();
    expect(f.wasDrag()).toBe(false);
  });

  it("no click after a touch drag (iOS): the next press clears it", () => {
    let t = 0;
    const f = createDragFlag(() => t);
    f.down();
    f.dragEnded();
    t += 50;
    f.down(); // the next tap's press
    expect(f.wasDrag()).toBe(false);
  });

  it("expires after DRAG_CLICK_MS even without a press", () => {
    let t = 0;
    const f = createDragFlag(() => t);
    f.dragEnded();
    t += DRAG_CLICK_MS;
    expect(f.wasDrag()).toBe(false);
    f.dragEnded();
    t += DRAG_CLICK_MS - 1;
    expect(f.wasDrag()).toBe(true);
    expect(f.wasDrag()).toBe(false); // read once
  });

  it("a double tap right after a drag needs only two taps", () => {
    let t = 0;
    const f = createDragFlag(() => t);
    const did: string[] = [];
    const tapper = createTapper({
      onSingle: () => did.push("single"),
      onDouble: () => did.push("double"),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    const click = () => !f.wasDrag() && tapper.tap();
    f.down();
    t += 300;
    f.dragEnded(); // touch drag: no click follows
    t += 500;
    f.down();
    click();
    t += 100;
    f.down();
    click();
    expect(did).toEqual(["double"]);
    expect(createDragFlag().wasDrag()).toBe(false);
  });
});
