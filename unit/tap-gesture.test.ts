import { describe, expect, it } from "bun:test";
import { DOUBLE_TAP_MS, createTapper } from "@/lib/tap-gesture";

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
