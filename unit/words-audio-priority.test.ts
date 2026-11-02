import { describe, expect, test } from "bun:test";
import { rowPriority } from "@/lib/words/audio-priority";

describe("rowPriority", () => {
  test("on screen first, then outward from it, then past the window", () => {
    expect(rowPriority(20, 4, 6, 2, 9, 2)).toEqual({
      visible: [4, 5],
      rest: [6, 3, 7, 2, 8, 9, 10],
    });
  });

  test("at the top: only below", () => {
    expect(rowPriority(10, 0, 2, 0, 4, 1)).toEqual({ visible: [0, 1], rest: [2, 3, 4] });
  });

  test("clamped to the queue", () => {
    expect(rowPriority(3, 1, 9, -5, 20, 5)).toEqual({ visible: [1, 2], rest: [0] });
    expect(rowPriority(0, 0, 3, 0, 3, 3)).toEqual({ visible: [], rest: [] });
  });
});
