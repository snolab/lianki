import { describe, expect, test } from "bun:test";
import { CORD_REACH, cordPath, cordPull } from "@/lib/words/cords";

describe("cordPath", () => {
  test("a tied cord is a straight line from top to bottom", () => {
    expect(cordPath(4.5, 44, 0, 0)).toBe("M 4.5 0 C 4.5 11, 4.5 15.4, 4.5 22 S 4.5 33, 4.5 44");
  });
  test("a loose cord passes through its displaced middle and keeps its ends", () => {
    const d = cordPath(4.5, 44, 7, 10);
    expect(d.startsWith("M 4.5 0 ")).toBe(true);
    expect(d.endsWith(", 4.5 44")).toBe(true);
    expect(d).toContain("21.5 22");
  });
});

describe("cordPull", () => {
  test("a tied cord does not follow the slide", () => {
    expect(cordPull(80, 0, 44)).toBe(0);
  });
  test("a loose cord follows a small slide fully, a big one only to its reach", () => {
    expect(cordPull(10, 1, 44)).toBe(10);
    expect(cordPull(200, 1, 44)).toBeCloseTo(CORD_REACH * 44);
    expect(cordPull(-200, 1, 44)).toBeCloseTo(-CORD_REACH * 44);
  });
});
