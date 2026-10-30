import { describe, expect, test } from "bun:test";
import { shouldAdvance } from "@/lib/words/advance";
import {
  applyMotionAttr,
  installMotionAttr,
  motionOff,
  motionStore,
  resolveMotionOff,
  setMotionOff,
  subscribeMotion,
  systemReducedMotion,
} from "@/lib/motion-pref";
import { MOTION_BOOT_SCRIPT } from "@/lib/motion-boot";
import {
  FEEL_KEYS,
  FEEL_PRESETS,
  cleanTweaks,
  resolveFeel,
  DEFAULT_PREFS,
} from "@/lib/words/swipe-feel";

describe("auto-advance (owner, 2026-10-30)", () => {
  test("a card not graded yet advances", () => {
    expect(shouldAdvance(new Map(), 3)).toBe(true);
    expect(shouldAdvance(new Map([[2, { rating: 3 }]]), 3)).toBe(true);
  });
  test("re-grading a card already graded stays put", () => {
    expect(shouldAdvance(new Map([[3, { rating: 1 }]]), 3)).toBe(false);
  });
});

describe("Turn off animations (lib/motion-pref.ts)", () => {
  test("follows the system until chosen", () => {
    expect(resolveMotionOff("system", true)).toBe(true);
    expect(resolveMotionOff("system", false)).toBe(false);
    expect(resolveMotionOff("off", false)).toBe(true);
    expect(resolveMotionOff("on", true)).toBe(false);
  });
  test("the store is the device preference lk:pref:motion", () => {
    expect(motionStore.key).toBe("lk:pref:motion");
    expect(motionStore.getState().animations).toBe("system");
    setMotionOff(true);
    expect(motionOff()).toBe(true);
    setMotionOff(false);
    expect(motionOff()).toBe(false);
    motionStore.setState({ animations: "system" });
  });
  test("the boot script reads the stored shape and sets data-motion", () => {
    const run = (stored: string | null) => {
      const root = { dataset: {} as Record<string, string> };
      new Function("localStorage", "document", MOTION_BOOT_SCRIPT)(
        { getItem: () => stored },
        { documentElement: root },
      );
      return root.dataset.motion;
    };
    expect(run(JSON.stringify({ state: { animations: "off" }, version: 1 }))).toBe("off");
    expect(run(JSON.stringify({ state: { animations: "on" }, version: 1 }))).toBeUndefined();
    expect(run(null)).toBeUndefined();
    expect(run("{bad json")).toBeUndefined();
  });
});

describe("motion-pref in a browser", () => {
  test("the attribute follows the store", () => {
    const root = { dataset: {} as DOMStringMap };
    const off = installMotionAttr(root);
    expect(root.dataset.motion).toBeUndefined();
    setMotionOff(true);
    expect(root.dataset.motion).toBe("off");
    setMotionOff(false);
    expect(root.dataset.motion).toBeUndefined();
    off();
    setMotionOff(true);
    applyMotionAttr(root);
    expect(root.dataset.motion).toBe("off");
    motionStore.setState({ animations: "system" });
  });
  test("the system's reduced motion, and its changes, reach subscribers", () => {
    const g = globalThis as { matchMedia?: unknown };
    const saved = g.matchMedia;
    let reduce = true;
    const listeners = new Set<() => void>();
    g.matchMedia = () => ({
      get matches() {
        return reduce;
      },
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    });
    try {
      expect(systemReducedMotion()).toBe(true);
      expect(motionOff()).toBe(true);
      let calls = 0;
      const unsub = subscribeMotion(() => calls++);
      reduce = false;
      for (const l of listeners) l();
      setMotionOff(true);
      expect(calls).toBe(2);
      unsub();
      expect(listeners.size).toBe(0);
      g.matchMedia = () => {
        throw new Error("no media queries");
      };
      expect(systemReducedMotion()).toBe(false);
      subscribeMotion(() => {})();
    } finally {
      g.matchMedia = saved;
      motionStore.setState({ animations: "system" });
    }
  });
});

describe("the swipe never tilts (owner, 2026-10-30)", () => {
  test("no rotation token in either preset or the tuner", () => {
    expect(FEEL_KEYS as string[]).not.toContain("rotatePerPx");
    for (const p of ["light", "heavy"] as const)
      expect(Object.keys(FEEL_PRESETS[p])).not.toContain("rotatePerPx");
  });
  test("a stored or published tilt is dropped", () => {
    expect(cleanTweaks({ rotatePerPx: 0.02, damping: 50 })).toEqual({ damping: 50 });
    const feel = resolveFeel(DEFAULT_PREFS, { light: { rotatePerPx: 1 } as never });
    expect("rotatePerPx" in feel).toBe(false);
  });
});
