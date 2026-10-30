import { describe, expect, it } from "bun:test";
import {
  EDGE_MAX_SPEED,
  EDGE_MAX_SPEED_REDUCED,
  EDGE_ZONE_PX,
  createJoystick,
  edgeSpeed,
} from "@lianki/debug-chat/joystick";

const area = { top: 50, bottom: 800 };
const armed = { bottomArmed: true };

describe("edgeSpeed", () => {
  it("still in the middle; forward at the top edge, back at the bottom", () => {
    expect(edgeSpeed(400, area, armed).speed).toBe(0);
    expect(edgeSpeed(area.top, area, armed).speed).toBe(EDGE_MAX_SPEED);
    expect(edgeSpeed(area.bottom, area, armed).speed).toBe(-EDGE_MAX_SPEED);
  });

  it("faster the deeper into the band (eased), linear and slower under reduced motion", () => {
    const half = area.top + EDGE_ZONE_PX / 2;
    expect(edgeSpeed(half, area, armed).speed).toBeCloseTo(EDGE_MAX_SPEED / 4, 5);
    expect(edgeSpeed(half, area, armed, { reduced: true }).speed).toBeCloseTo(
      EDGE_MAX_SPEED_REDUCED / 2,
      5,
    );
    // Past the edge (the finger off the visible area): capped.
    expect(edgeSpeed(area.top - 40, area, armed).speed).toBe(EDGE_MAX_SPEED);
  });

  it("the bottom band arms only once the finger has been above it", () => {
    let s = { bottomArmed: false };
    // The drag starts on the bar, inside the bottom band: nothing yet.
    let r = edgeSpeed(780, area, s);
    expect(r.speed).toBe(0);
    s = r.state;
    // Up out of it…
    r = edgeSpeed(600, area, s);
    s = r.state;
    expect(s.bottomArmed).toBe(true);
    // …and back down: now it scrolls back.
    expect(edgeSpeed(790, area, s).speed).toBeLessThan(0);
  });
});

/** Frames driven by hand. */
function fakeFrames() {
  let next = 1;
  const due = new Map<number, (t: number) => void>();
  return {
    request: (cb: (t: number) => void) => {
      due.set(next, cb);
      return next++;
    },
    cancel: (id: number) => void due.delete(id),
    step(t: number) {
      const fns = [...due.values()];
      due.clear();
      for (const f of fns) f(t);
    },
    pending: () => due.size,
  };
}

describe("createJoystick", () => {
  it("scrolls by speed × time per frame while set, one loop", () => {
    const f = fakeFrames();
    const moved: number[] = [];
    const j = createJoystick((px) => moved.push(px), f);
    j.set(1000);
    j.set(1000); // no second loop
    expect(f.pending()).toBe(1);
    f.step(0); // the first frame only takes the time
    f.step(16);
    f.step(32);
    expect(moved).toEqual([16, 16]);
    expect(j.running()).toBe(true);
  });

  it("caps a long gap at 50 ms (a stalled tab)", () => {
    const f = fakeFrames();
    const moved: number[] = [];
    const j = createJoystick((px) => moved.push(px), f);
    j.set(-1000);
    f.step(0);
    f.step(400);
    expect(moved).toEqual([-50]);
  });

  it("stops at 0 and starts over cleanly; dispose leaves no frame", () => {
    const f = fakeFrames();
    const moved: number[] = [];
    const j = createJoystick((px) => moved.push(px), f);
    j.set(1000);
    f.step(0);
    j.set(0);
    expect(f.pending()).toBe(0);
    expect(j.running()).toBe(false);
    j.set(500);
    f.step(1000); // a fresh start: no jump for the time it was stopped
    f.step(1010);
    expect(moved).toEqual([5]);
    j.dispose();
    expect(f.pending()).toBe(0);
    j.set(1000); // disposed: nothing starts again
    expect(f.pending()).toBe(0);
  });

  it("uses the page's requestAnimationFrame by default", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const calls: string[] = [];
    g.requestAnimationFrame = () => (calls.push("request"), 7);
    g.cancelAnimationFrame = (id: number) => void calls.push(`cancel ${id}`);
    try {
      const j = createJoystick(() => {});
      j.set(100);
      j.dispose();
      expect(calls).toEqual(["request", "cancel 7"]);
    } finally {
      delete g.requestAnimationFrame;
      delete g.cancelAnimationFrame;
    }
  });

  it("a frame that fires after it stopped does nothing", () => {
    const f = fakeFrames();
    const moved: number[] = [];
    const j = createJoystick((px) => moved.push(px), f);
    j.set(1000);
    const ids = f.pending();
    expect(ids).toBe(1);
    j.dispose();
    f.step(10);
    expect(moved).toEqual([]);
  });
});
