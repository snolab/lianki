/**
 * The reader's word review as a bottom sheet (lib/read/review-sheet.ts; owner,
 * 2026-11-09 00:51 JST): resting heights leave the text visible above, a drag
 * resizes it, and a drag or flick down far enough closes it.
 */
import { describe, expect, test } from "bun:test";
import { dragHeight, sheetRelease, sheetSnaps } from "@/lib/read/review-sheet";

const vh = 800;
const snaps = sheetSnaps(vh, 120);

describe("sheetSnaps", () => {
  test("half, three quarters, and the tallest that leaves the reserve visible", () => {
    expect(snaps).toEqual([400, 600, 680]);
    expect(Math.max(...snaps)).toBeLessThan(vh);
  });
  test("a short viewport: never taller than the reserve allows, no duplicates", () => {
    expect(sheetSnaps(300, 200)).toEqual([100]);
  });
});

describe("dragHeight", () => {
  test("follows the finger, within 0 and the tallest snap", () => {
    expect(dragHeight(600, 100, snaps)).toBe(500);
    expect(dragHeight(600, -500, snaps)).toBe(680);
    expect(dragHeight(600, 900, snaps)).toBe(0);
  });
});

describe("sheetRelease", () => {
  test("let go slowly: the nearest resting height", () => {
    expect(sheetRelease(600, 150, 0, snaps)).toEqual({ close: false, h: 400 });
    expect(sheetRelease(600, -60, 0, snaps)).toEqual({ close: false, h: 680 });
    expect(sheetRelease(600, 20, 0, snaps)).toEqual({ close: false, h: 600 });
  });
  test("dragged well under the shortest: closed", () => {
    expect(sheetRelease(600, 400, 0, snaps)).toEqual({ close: true });
  });
  test("a flick goes one snap along; down past the shortest closes", () => {
    expect(sheetRelease(600, 30, 1, snaps)).toEqual({ close: false, h: 400 });
    expect(sheetRelease(400, 30, 1, snaps)).toEqual({ close: true });
    expect(sheetRelease(400, -30, -1, snaps)).toEqual({ close: false, h: 600 });
    expect(sheetRelease(680, -10, -1, snaps)).toEqual({ close: false, h: 680 });
  });
});
