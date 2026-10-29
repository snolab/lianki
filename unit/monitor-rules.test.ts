import { describe, expect, test } from "bun:test";
import { WINDOW_MS, inWindow, pathGroup, quiet, secs } from "../workers/monitor/src/rules";

test("secs: one decimal", () => {
  expect(secs(1234)).toBe("1.2s");
});

describe("inWindow", () => {
  test("drops what fell out of the window", () => {
    const now = WINDOW_MS + 5;
    expect(inWindow([0, 4, 10], now, now)).toEqual([10, now]);
    expect(inWindow([10], 20, 30)).toEqual([10, 20]);
  });
});

describe("pathGroup", () => {
  test("collapses ids so paths aggregate", () => {
    expect(
      pathGroup("https://lianki.com/api/words/lists/b6030131-b227-4703-b2e6-b7113f1c0768/review"),
    ).toBe("/api/words/lists/:id/review");
    expect(pathGroup("https://lianki.com/home?x=1")).toBe("/home");
    expect(pathGroup("not a url")).toBe("?");
  });
});

describe("quiet", () => {
  test("over once the last event left the window", () => {
    expect(quiet([0, 5], WINDOW_MS + 4)).toBe(false);
    expect(quiet([0, 5], WINDOW_MS + 5)).toBe(true);
    expect(quiet([], 0)).toBe(true);
  });
});
