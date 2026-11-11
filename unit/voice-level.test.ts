// The caret's level bus (packages/debug-chat/src/voice-level.ts).
import { describe, expect, it } from "bun:test";
import { levelOf, publishLevel, subscribeLevel } from "../packages/debug-chat/src/voice-level";

describe("levelOf", () => {
  it("takes the VAD's speech probability when there is one, clamped", () => {
    expect(levelOf(new Float32Array(512), 0.7)).toBe(0.7);
    expect(levelOf(new Float32Array(512), 1.4)).toBe(1);
    expect(levelOf(new Float32Array(512), -1)).toBe(0);
  });
  it("falls back to loudness: silence 0, a normal voice near full", () => {
    expect(levelOf(new Float32Array(512))).toBe(0);
    expect(levelOf(new Float32Array(512).fill(0.05))).toBeCloseTo(0.5);
    expect(levelOf(new Float32Array(512).fill(0.5))).toBe(1);
  });
});

describe("the bus", () => {
  it("hands every frame's level to each listener until it unsubscribes", () => {
    const got: number[] = [];
    const off = subscribeLevel((l) => got.push(l));
    publishLevel(0.2);
    publishLevel(0.9);
    off();
    publishLevel(0.5);
    expect(got).toEqual([0.2, 0.9]);
  });
});
