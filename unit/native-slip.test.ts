import { describe, expect, test } from "bun:test";
import { GLIDE_RETRIES, homeStep, onDetent } from "../lib/words/native-slip";

describe("onDetent: the lift's timer settles a slip only on a detent", () => {
  test("on a detent, within a physical pixel", () => {
    expect(onDetent(88, 44)).toBe(true);
    expect(onDetent(44, 44)).toBe(true);
    expect(onDetent(0, 44)).toBe(true);
    expect(onDetent(176, 44)).toBe(true);
    // Android's fractional DPR: 1 / 2.625 px off
    expect(onDetent(44.38, 44)).toBe(true);
    expect(onDetent(87.7, 44)).toBe(true);
  });
  test("a pixel short is not resting: the browser still snaps it (owner, Android, 2026-11-03)", () => {
    // Lifted at 43 for the detent at 44: Chrome snapped the last pixel and
    // overrode the glide home the timer had started.
    expect(onDetent(43, 44)).toBe(false);
    expect(onDetent(89, 44)).toBe(false);
    expect(onDetent(66, 44)).toBe(false);
  });
  test("any row height (text size scales it)", () => {
    expect(onDetent(2 * 53, 53)).toBe(true);
    expect(onDetent(53 - 1, 53)).toBe(false);
  });
  test("no height, no detent", () => {
    expect(onDetent(0, 0)).toBe(false);
    expect(onDetent(10, Number.NaN)).toBe(false);
  });
});

describe("homeStep: a glide home that stops short is never left there", () => {
  test("home under a pixel", () => {
    expect(homeStep(0, 1)).toBe("home");
    expect(homeStep(0.6, 1)).toBe("home");
    expect(homeStep(-0.6, 3)).toBe("home");
  });
  test("stopped on the first detent: glide again", () => {
    expect(homeStep(44, 1)).toBe("glide");
    expect(homeStep(-44, 1)).toBe("glide");
  });
  test("glides are bounded, then it is put home at once", () => {
    let tries = 1;
    const steps: string[] = [];
    for (;;) {
      const s = homeStep(44, tries);
      steps.push(s);
      if (s !== "glide") break;
      tries++;
    }
    expect(steps).toEqual([...Array(GLIDE_RETRIES).fill("glide"), "jump"]);
  });
  test("never waits: every step off home moves the slip", () => {
    for (const off of [1, 5, 44, 88, -1, -88])
      for (let t = 0; t <= GLIDE_RETRIES + 3; t++) expect(homeStep(off, t)).not.toBe("home");
  });
});
