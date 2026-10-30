import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  type SwipeRowValue,
  SwipeRowProvider,
  useSwipeFeel,
  useSwipeRow,
} from "@/lib/words/swipe-core";
import { SwipeCard } from "@/lib/words/islands/SwipeCard";
import { SwipeCue } from "@/lib/words/islands/SwipeCue";
import {
  dampingRatio,
  flingAt,
  flingDistance,
  flingSeconds,
  followSwipe,
  releaseTrajectory,
  rubberBand,
  springAt,
  springSettle,
  springStep,
  trajectoryEasing,
} from "@/lib/words/swipe-physics";
import {
  FEEL_PRESETS,
  cleanTweaks,
  feelOverride,
  feelTag,
  parsePrefs,
  resolveFeel,
} from "@/lib/words/swipe-feel";
import { IDLE, type GestureEvent, type GestureState, stepGesture } from "@/lib/words/swipe-machine";
import {
  SWIPE_RETURN_S,
  SWIPE_SPRING,
  releaseRating,
  snapSwipe,
  springProgress,
} from "@/lib/words/swipe";
import { springStep as criticalStep } from "@/lib/words/motion";

const light = FEEL_PRESETS.light;
const heavy = FEEL_PRESETS.heavy;
const A = 44;

describe("spring", () => {
  it("light is the shipped critically damped spring (ω = SWIPE_SPRING)", () => {
    expect(dampingRatio(light)).toBeCloseTo(1, 6);
    for (const t of [0, 0.02, 0.05, 0.1, 0.2]) {
      const s = springAt(88, 0, light, t);
      expect(s.x).toBeCloseTo(88 * (1 - springProgress(t / SWIPE_RETURN_S)), 6);
      const c = criticalStep(88, 0, 0, t, SWIPE_SPRING);
      expect(s.x).toBeCloseTo(c.x, 6);
      expect(s.v).toBeCloseTo(c.v, 4);
    }
  });

  it("heavy is slightly underdamped: heavier and slower, with one faint overshoot", () => {
    const z = dampingRatio(heavy);
    expect(z).toBeGreaterThan(0.8);
    expect(z).toBeLessThan(1);
    let min = 0;
    for (let t = 0; t < 2; t += 0.002) min = Math.min(min, springAt(88, 0, heavy, t).x);
    // Overshoots home by under 1% of the travel: weight, not a wobble.
    expect(min).toBeLessThan(0);
    expect(-min).toBeLessThan(0.01 * 88);
    expect(springSettle(88, 0, heavy)).toBeGreaterThan(springSettle(88, 0, light) * 1.3);
  });

  it("is exact: velocity is the derivative of position (all three regimes)", () => {
    const over = { mass: 1, stiffness: 100, damping: 40 };
    for (const p of [light, heavy, over]) {
      const h = 1e-5;
      for (const t of [0.01, 0.07, 0.2]) {
        const dx = (springAt(30, -400, p, t + h).x - springAt(30, -400, p, t - h).x) / (2 * h);
        expect(springAt(30, -400, p, t).v).toBeCloseTo(dx, 2);
      }
      expect(springAt(30, -400, p, 0).x).toBeCloseTo(30, 9);
      expect(springAt(30, -400, p, 0).v).toBeCloseTo(-400, 6);
    }
  });

  it("steps the same path at any frame rate", () => {
    const run = (dt: number) => {
      let s = { x: 50, v: 300 };
      for (let t = 0; t < 0.3 - 1e-9; t += dt) s = springStep(s.x, s.v, 0, dt, heavy);
      return s;
    };
    const a = run(1 / 60);
    const b = run(1 / 120);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.v).toBeCloseTo(b.v, 4);
  });
});

describe("fling", () => {
  it("decays exponentially and stops at v0/k", () => {
    expect(flingDistance(1000, 5)).toBe(200);
    expect(flingAt(0, 1000, 5, 100).x).toBeCloseTo(200, 6);
    expect(flingAt(0, 1000, 5, Math.log(2) / 5).v).toBeCloseTo(500, 6);
    expect(flingAt(10, 1000, 0, 1)).toEqual({ x: 10, v: 0 });
    expect(flingSeconds(1000, 100, 5)).toBeCloseTo(Math.log(10) / 5, 9);
    expect(flingSeconds(50, 100, 5)).toBe(0);
  });
});

describe("rubber band", () => {
  it("follows ~c at first, never reaches d, and is odd", () => {
    expect(rubberBand(0, 22, 0.55)).toBe(0);
    expect(rubberBand(0.01, 22, 0.55) / 0.01).toBeCloseTo(0.55, 3);
    expect(rubberBand(1e6, 22, 0.55)).toBeLessThan(22);
    expect(rubberBand(1e6, 22, 0.55)).toBeGreaterThan(21.9);
    expect(rubberBand(-10, 22, 0.55)).toBe(-rubberBand(10, 22, 0.55));
    expect(rubberBand(10, 22, 0.3)).toBeLessThan(rubberBand(10, 22, 0.55));
  });

  it("light follow is the shipped staircase; heavy only changes what lies past the last level", () => {
    for (const f of [-200, -90, -60, -30, -5, 0, 7, 26, 44, 70, 88, 100, 150, 300])
      expect(followSwipe(f, light, A)).toBeCloseTo(snapSwipe(f, A), 9);
    for (const f of [-88, -44, 0, 20, 44, 70, 88])
      expect(followSwipe(f, heavy, A)).toBeCloseTo(snapSwipe(f, A), 9);
    // Past 2a: eases into the 2.5a stop instead of a hard stop.
    const past = [100, 120, 160, 400].map((f) => followSwipe(f, heavy, A));
    for (let i = 1; i < past.length; i++) expect(past[i]).toBeGreaterThan(past[i - 1]);
    expect(past.at(-1)!).toBeLessThan(2.5 * A);
    expect(followSwipe(-400, heavy, A)).toBeCloseTo(-past.at(-1)!, 9);
  });
});

describe("release trajectory", () => {
  it("light: no coast — the shipped return, from the release point", () => {
    const tr = releaseTrajectory(88, 1500, light);
    expect(tr.peak).toBe(88);
    expect(tr.at(0)).toBe(88);
    expect(tr.at(0.1)).toBeCloseTo(88 * (1 - springProgress(0.1 / SWIPE_RETURN_S)), 6);
    expect(tr.seconds).toBeGreaterThan(SWIPE_RETURN_S * 0.9);
    expect(tr.seconds).toBeLessThan(SWIPE_RETURN_S * 1.2);
    expect(tr.at(tr.seconds)).toBe(0);
  });

  it("heavy: a fling coasts on, slows, then springs home — longer, continuous, within reach", () => {
    const tr = releaseTrajectory(60, 1200, heavy, 2.5 * A);
    expect(tr.peak).toBeGreaterThan(60);
    expect(tr.peak).toBeLessThan(2.5 * A * 1.2);
    expect(tr.seconds).toBeGreaterThan(releaseTrajectory(60, 1200, light).seconds * 1.5);
    let prev = tr.at(0);
    let maxJump = 0;
    for (let i = 1; i <= 400; i++) {
      const x = tr.at((tr.seconds * i) / 400);
      maxJump = Math.max(maxJump, Math.abs(x - prev));
      prev = x;
    }
    // No teleport between frames-worth of samples.
    expect(maxJump).toBeLessThan(6);
    expect(tr.at(tr.seconds)).toBe(0);
    // Decelerating out: each step outward is smaller than the last.
    const outs = [0, 0.02, 0.04, 0.06].map((t) => tr.at(t));
    expect(outs[2] - outs[1]).toBeLessThan(outs[1] - outs[0]);
  });

  it("a fling back toward home carries home faster; the fastest coast is capped", () => {
    const back = releaseTrajectory(60, -1200, heavy);
    expect(back.peak).toBe(60);
    const a = releaseTrajectory(60, 1e6, heavy);
    const b = releaseTrajectory(60, heavy.maxFling / heavy.flingCarry, heavy);
    expect(a.peak).toBeCloseTo(b.peak, 6);
  });

  it("becomes a CSS easing from translateX(x0) to 0", () => {
    const tr = releaseTrajectory(60, 1200, heavy);
    const e = trajectoryEasing(tr, 60)!;
    expect(e.startsWith("linear(0, ")).toBe(true);
    expect(e.endsWith(", 1)")).toBe(true);
    // Coasting out = progress below 0.
    expect(e).toContain("-");
    expect(trajectoryEasing(tr, 0.1)).toBeNull();
  });
});

describe("feel tokens", () => {
  it("presets keep every threshold: the level hold and the levels' positions match", () => {
    // The grade (releaseRating) takes no feel at all; the follow agrees on every level.
    expect(heavy.snap).toBe(light.snap);
    for (const k of [-2, -1, 0, 1, 2]) expect(followSwipe(k * A, heavy, A)).toBeCloseTo(k * A, 9);
  });

  it("stored prefs are checked; bad values read as the default", () => {
    expect(parsePrefs(null)).toEqual({ preset: "light", tweaks: {}, tune: false });
    expect(parsePrefs("{nope")).toEqual({ preset: "light", tweaks: {}, tune: false });
    expect(
      parsePrefs(
        JSON.stringify({ preset: "heavy", tweaks: { mass: 99, x: 1, damping: "a" }, tune: true }),
      ),
    ).toEqual({ preset: "heavy", tweaks: { mass: 6 }, tune: true });
    expect(cleanTweaks({ nativeRelease: 1, lift: 0.5 })).toEqual({ lift: 0.5 });
  });

  it("resolves preset → published tune → device tweaks; ?feel= overrides the preset", () => {
    const prefs = { preset: "heavy" as const, tweaks: { damping: 50 }, tune: false };
    const f = resolveFeel(prefs, { heavy: { damping: 70, friction: 4 }, light: { mass: 3 } });
    expect(f.damping).toBe(50);
    expect(f.friction).toBe(4);
    expect(f.mass).toBe(heavy.mass);
    expect(resolveFeel(prefs, {}, "light").mass).toBe(1);
    expect(feelOverride("?feel=heavy")).toBe("heavy");
    expect(feelOverride("?feel=x")).toBeNull();
    expect(feelTag("light", {})).toBe("");
    expect(feelTag("heavy", {})).toBe("feel=heavy");
    expect(feelTag("light", { mass: 2 })).toBe("feel=light+1");
  });
});

describe("gesture machine", () => {
  const run = (events: GestureEvent[]) => {
    let s: GestureState = IDLE;
    const fx: string[] = [];
    for (const e of events) {
      const r = stepGesture(s, e, A);
      s = r.state;
      fx.push(...r.effects.map((f) => f.type));
    }
    return { s, fx };
  };
  const down = (t = 0): GestureEvent => ({ type: "down", x: 100, y: 100, t, catching: false });

  it("a tap is a tap; a hold is a hold and never grades", () => {
    expect(run([down(), { type: "up", t: 50 }]).fx).toContain("tap");
    const h = run([
      down(),
      { type: "hold" },
      { type: "move", x: 200, y: 100, t: 400 },
      { type: "up", t: 500 },
    ]);
    expect(h.fx).toContain("holdEnd");
    expect(h.fx).not.toContain("release");
    expect(h.fx).not.toContain("slide");
  });

  it("a sideways drag slides, ticks the levels, grades on release and goes home", () => {
    const evs: GestureEvent[] = [down()];
    for (let i = 1; i <= 10; i++) evs.push({ type: "move", x: 100 + i * 8, y: 101, t: i * 16 });
    evs.push({ type: "up", t: 170 });
    const { s, fx } = run(evs);
    expect(fx).toContain("slide");
    expect(fx.filter((f) => f === "level").length).toBeGreaterThan(0);
    expect(fx.indexOf("return")).toBeLessThan(fx.indexOf("release"));
    expect(s.phase).toBe("settling");
    expect(stepGesture(s, { type: "settled" }, A).state.phase).toBe("idle");
  });

  it("a steep drag scrolls and never grades; a touch catching a fling never taps", () => {
    const v = run([
      down(),
      { type: "move", x: 102, y: 130, t: 16 },
      { type: "move", x: 160, y: 140, t: 32 },
      { type: "up", t: 40 },
    ]);
    expect(v.fx).not.toContain("slide");
    expect(v.fx).not.toContain("tap");
    const c = run([
      { type: "down", x: 0, y: 0, t: 0, catching: true },
      { type: "up", t: 30 },
    ]);
    expect(c.fx).not.toContain("tap");
    expect(c.fx).not.toContain("armHold");
  });

  it("a cancel ends a hold, sends a slide home, and is quiet otherwise", () => {
    const held = run([down(), { type: "hold" }, { type: "cancel" }]);
    expect(held.fx).toContain("holdEnd");
    expect(held.s.phase).toBe("idle");
    const slid = run([down(), { type: "move", x: 140, y: 100, t: 16 }, { type: "cancel" }]);
    expect(slid.fx.at(-1)).toBe("return");
    expect(slid.fx).not.toContain("release");
    expect(slid.s.phase).toBe("settling");
    const pressed = run([down(), { type: "cancel" }]);
    expect(pressed.fx).toEqual(["armHold", "disarmHold"]);
    expect(pressed.s.phase).toBe("idle");
    // Events out of place change nothing.
    expect(
      run([{ type: "hold" }, { type: "settled" }, { type: "move", x: 1, y: 1, t: 1 }]).s,
    ).toEqual(IDLE);
  });

  it("a twitch under SWIPE_START grades nothing", () => {
    const evs: GestureEvent[] = [
      down(),
      { type: "move", x: 112, y: 100, t: 10 },
      { type: "up", t: 20 },
    ];
    const r = stepGesture(run(evs.slice(0, 2)).s, evs[2], A);
    const rel = r.effects.find((f) => f.type === "release");
    expect(rel && rel.type === "release" && rel.release.rating).toBeNull();
  });
});

describe("core interface: islands read it through context", () => {
  const noop = () => {};
  const row = (feel = heavy): SwipeRowValue => ({
    iface: 1,
    variant: "js",
    phase: "dragging",
    feel,
    reducedMotion: false,
    card: {
      bind: {
        ref: noop,
        onPointerDown: noop,
        onPointerMove: noop,
        onPointerUp: noop,
        onPointerCancel: noop,
      },
      index: 3,
      className: "slip",
      style: { height: 44 },
      children: createElement(SwipeCue),
    },
  });
  const render = (v: SwipeRowValue) =>
    renderToString(
      createElement(SwipeRowProvider, { value: v, children: createElement(SwipeCard) }),
    );

  it("the card renders the core's slot; the cue lifts only on a feel with lift", () => {
    const html = render(row());
    expect(html).toContain('data-i="3"');
    expect(html).toContain('data-swipe-phase="dragging"');
    expect(html).toContain('data-swipe-cue="up"');
    const plain = render(row(light));
    expect(plain).not.toContain("data-swipe-phase");
    expect(plain).not.toContain("data-swipe-cue");
  });

  it("an island written for another interface version throws (its boundary falls back)", () => {
    expect(() => useSwipeRow(2)).toThrow(/interface v1, the island expects v2/);
    expect(() => useSwipeFeel(0)).toThrow(/interface/);
  });
});
