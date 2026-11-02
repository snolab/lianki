import { describe, expect, test } from "bun:test";
import { cordPath } from "@/lib/words/cords";

/** The path's points as [x, y] pairs. */
const points = (d: string) =>
  [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

describe("cordPath", () => {
  test("a tied cord is a straight line from top to bottom", () => {
    expect(cordPath(4.5, 44, 0)).toBe("M 4.5 0 C 4.5 11, 4.5 15.4, 4.5 22 S 4.5 33, 4.5 44");
  });
  test("a loose cord passes through its bowed middle and keeps its ends", () => {
    const d = cordPath(4.5, 44, 7);
    expect(d.startsWith("M 4.5 0 ")).toBe(true);
    expect(d.endsWith(", 4.5 44")).toBe(true);
    expect(d).toContain("11.5 22");
  });
  test("scaleX about x turns the full bow into any smaller one (the CSS loosening)", () => {
    const full = points(cordPath(4.5, 44, 7.48));
    for (const s of [0, 0.25, 0.5]) {
      const scaled = full.map(([x, y]) => [4.5 + (x - 4.5) * s, y]);
      const want = points(cordPath(4.5, 44, 7.48 * s));
      scaled.forEach(([x, y], k) => {
        expect(x).toBeCloseTo(want[k][0], 1);
        expect(y).toBe(want[k][1]);
      });
    }
  });
});
