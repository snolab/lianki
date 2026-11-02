import { afterEach, describe, expect, it } from "bun:test";
import {
  JOYSTICK_TUNE,
  createJoystick,
  deadZoneSpeed,
  joystickTune,
} from "@lianki/debug-chat/joystick";

const T = JOYSTICK_TUNE;

describe("deadZoneSpeed (a dead zone around the press, like a touchpad)", () => {
  it("inside the circle: a plain drag, no joystick", () => {
    expect(deadZoneSpeed(0, 0)).toEqual({ inside: true, speed: 0 });
    expect(deadZoneSpeed(0, T.radius)).toEqual({ inside: true, speed: 0 });
    expect(deadZoneSpeed(T.radius * 0.7, -T.radius * 0.7)).toEqual({ inside: true, speed: 0 });
  });

  it("outside: below the press scrolls back, above it forward, faster further out", () => {
    const near = deadZoneSpeed(0, T.radius + T.ramp / 2);
    const far = deadZoneSpeed(0, T.radius + T.ramp);
    expect(near.inside).toBe(false);
    expect(near.speed).toBeCloseTo(-T.max / 4, 5); // eased: half the ramp, a quarter of the speed
    expect(far.speed).toBeCloseTo(-T.max, 5);
    expect(deadZoneSpeed(0, -(T.radius + T.ramp * 3)).speed).toBeCloseTo(T.max, 5); // capped
  });

  it("only the vertical part of the push counts; sideways is nothing", () => {
    const d = T.radius + T.ramp;
    expect(deadZoneSpeed(d, 0).speed).toBeCloseTo(0, 5);
    expect(deadZoneSpeed(d / Math.SQRT2, d / Math.SQRT2).speed).toBeCloseTo(-T.max / Math.SQRT2, 5);
  });

  it("reduced motion: linear and slower", () => {
    expect(deadZoneSpeed(0, T.radius + T.ramp / 2, T, true).speed).toBeCloseTo(
      -T.maxReduced / 2,
      5,
    );
  });
});

describe("joystickTune (the radius and speeds, tunable from the page)", () => {
  afterEach(() => {
    delete (globalThis as { __lkJoystickTune?: unknown }).__lkJoystickTune;
  });
  it("the defaults, with the page's valid overrides only", () => {
    expect(joystickTune()).toEqual(JOYSTICK_TUNE);
    (globalThis as { __lkJoystickTune?: unknown }).__lkJoystickTune = {
      radius: 56,
      ramp: -1,
      max: "fast",
    };
    expect(joystickTune()).toEqual({ ...JOYSTICK_TUNE, radius: 56 });
    expect(joystickTune(null)).toEqual(JOYSTICK_TUNE);
    expect(deadZoneSpeed(0, 50, joystickTune({ radius: 56 })).inside).toBe(true);
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
