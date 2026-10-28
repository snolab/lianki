import { describe, expect, test } from "bun:test";
import { cssLinear, minJerk, moveSeconds, MIN_JERK_EASING, springStep } from "@/lib/words/motion";

describe("physical motion", () => {
  test("minimum jerk: rests at both ends, symmetric, no overshoot", () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBeCloseTo(1);
    expect(minJerk(0.5)).toBeCloseTo(0.5);
    // Starts gently: barely moved in the first 10% of the time.
    expect(minJerk(0.1)).toBeLessThan(0.01);
    for (let t = 0; t <= 1; t += 0.05) expect(minJerk(t)).toBeLessThanOrEqual(1.0000001);
  });

  test("CSS linear() easing", () => {
    expect(cssLinear((t) => t, 2)).toBe("linear(0, 0.5, 1)");
    expect(MIN_JERK_EASING.startsWith("linear(0, ")).toBe(true);
  });

  test("duration grows with the square root of distance", () => {
    const a = 450;
    expect(moveSeconds(0, a)).toBe(0);
    expect(moveSeconds(400, a) / moveSeconds(100, a)).toBeCloseTo(2);
    expect(moveSeconds(-100, a)).toBe(moveSeconds(100, a));
  });

  test("critically damped spring settles without overshoot and keeps velocity", () => {
    let s = { x: 0, v: 0 };
    let max = 0;
    for (let i = 0; i < 120; i++) {
      s = springStep(s.x, s.v, 100, 1 / 60, 12);
      max = Math.max(max, s.x);
    }
    expect(s.x).toBeCloseTo(100, 1);
    expect(max).toBeLessThanOrEqual(100.0001);
    // Mid-flight the velocity carries over (no restart from rest).
    const mid = springStep(0, 0, 100, 0.1, 12);
    expect(mid.v).toBeGreaterThan(0);
    // Frame-rate independent: one 0.2s step equals two 0.1s steps.
    const one = springStep(0, 0, 100, 0.2, 12);
    const two = springStep(mid.x, mid.v, 100, 0.1, 12);
    expect(two.x).toBeCloseTo(one.x, 6);
  });
});
