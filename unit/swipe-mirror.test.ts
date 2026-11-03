/**
 * The mirror (Settings → Mirror swipe sides, lib/words/swipe.ts): the sides
 * swap on both swipes — the js one (releaseRating, the machine) and the New
 * one (restRating) — and in what the slip uncovers (revealShownSide, and the
 * SwipeGrades island's layout).
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  type SwipeRating,
  mirrorRating,
  releaseRating,
  restRating,
  revealShownSide,
  sideGrade,
  sideRating,
} from "@/lib/words/swipe";
import { IDLE, type GestureState, stepGesture } from "@/lib/words/swipe-machine";
import { SwipeGrades } from "@/lib/words/islands/SwipeGrades";

const A = 44;

/** The js swipe: a drag of `dx` px, held still before the lift, through the machine. */
function jsGrade(dx: number, mirror: boolean): SwipeRating | null {
  let s: GestureState = IDLE;
  let rating: SwipeRating | null = null;
  const feed = (e: Parameters<typeof stepGesture>[1]) => {
    const r = stepGesture(s, e, A);
    s = r.state;
    for (const fx of r.effects) if (fx.type === "release") rating = fx.release.rating;
  };
  feed({ type: "down", x: 100, y: 100, t: 0, catching: false });
  for (let k = 1; k <= 10; k++) feed({ type: "move", x: 100 + (dx * k) / 10, y: 100, t: k * 16 });
  feed({ type: "up", t: 400 }); // held still: distance, not a flick
  return sideRating(rating, mirror);
}

/** The New swipe: a slip resting `offset` px from home (+ = slid right). */
const nativeGrade = (offset: number, mirror: boolean) => sideRating(restRating(offset, A), mirror);

describe("the mirror swaps the sides", () => {
  it("mirrorRating: Again ↔ Easy, Hard ↔ Good, and twice is none", () => {
    expect(([1, 2, 3, 4] as const).map(mirrorRating)).toEqual([4, 3, 2, 1]);
    for (const r of [1, 2, 3, 4] as const) expect(mirrorRating(mirrorRating(r))).toBe(r);
    expect(sideRating(null, true)).toBeNull();
    expect(sideRating(3, false)).toBe(3);
  });

  for (const [mode, grade, near, far] of [
    ["js", jsGrade, 50, 100],
    ["native", nativeGrade, A, 2 * A],
  ] as const) {
    it(`${mode}: off, ← Hard / Again and → Good / Easy`, () => {
      expect(grade(-near, false)).toBe(2);
      expect(grade(-far, false)).toBe(1);
      expect(grade(near, false)).toBe(3);
      expect(grade(far, false)).toBe(4);
    });
    it(`${mode}: mirrored, ← Good / Easy and → Hard / Again`, () => {
      expect(grade(-near, true)).toBe(3);
      expect(grade(-far, true)).toBe(4);
      expect(grade(near, true)).toBe(2);
      expect(grade(far, true)).toBe(1);
    });
    it(`${mode}: a twitch grades nothing either way`, () => {
      expect(grade(8, true)).toBeNull();
      expect(grade(-8, false)).toBeNull();
    });
  }

  it("mirrored left grades as right used to, on both swipes", () => {
    expect(jsGrade(-50, true)).toBe(jsGrade(50, false));
    expect(nativeGrade(-A, true)).toBe(nativeGrade(A, false));
    expect(releaseRating(-50, 0)).toBe(2);
  });

  it("voice and the help strip: the one-level grade of each side", () => {
    expect([sideGrade("left", false), sideGrade("right", false)]).toEqual([2, 3]);
    expect([sideGrade("left", true), sideGrade("right", true)]).toEqual([3, 2]);
  });

  it("the reveal: slid right uncovers the left side's grades, whichever they are", () => {
    // Off: slid right (k > 0) the good slot (left) switches to Easy at the far detent.
    expect(revealShownSide(2, false)).toEqual({ good: 4, hard: 2 });
    expect(revealShownSide(-2, false)).toEqual({ good: 3, hard: 1 });
    // Mirrored: slid right uncovers the hard slot (now on the left), far = Again.
    expect(revealShownSide(2, true)).toEqual({ good: 3, hard: 1 });
    expect(revealShownSide(-2, true)).toEqual({ good: 4, hard: 2 });
  });

  it("SwipeGrades puts Good / Easy on the right when mirrored", () => {
    const html = (mirror: boolean) =>
      renderToString(
        createElement(SwipeGrades, { again: "A", hard: "H", good: "G", easy: "E", mirror }),
      );
    expect(html(false)).toMatch(/data-reveal-slot="good" data-reveal-side="left"/);
    expect(html(false)).toMatch(/data-reveal-slot="hard" data-reveal-side="right"/);
    expect(html(true)).toMatch(/data-reveal-slot="good" data-reveal-side="right"/);
    expect(html(true)).toMatch(/data-reveal-slot="hard" data-reveal-side="left"/);
  });
});
