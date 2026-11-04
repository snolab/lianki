import { describe, expect, it } from "bun:test";
import { canScroll, forwardWheel, wheelPx } from "@lianki/debug-chat/wheel-forward";

const box = (scrollTop: number, scrollHeight = 600, clientHeight = 200) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});
const wheel = (o: Partial<Parameters<typeof forwardWheel>[0]>) =>
  forwardWheel({
    deltaX: 0,
    deltaY: -100,
    deltaMode: 0,
    ctrlKey: false,
    own: [],
    log: box(200),
    ...o,
  });

describe("canScroll", () => {
  it("no overflow: nothing to scroll", () => {
    expect(canScroll(box(0, 200, 200), 50)).toBe(false);
    expect(canScroll(box(0, 200, 200), -50)).toBe(false);
  });
  it("at the top only down, at the end only up", () => {
    expect(canScroll(box(0), -10)).toBe(false);
    expect(canScroll(box(0), 10)).toBe(true);
    expect(canScroll(box(400), 10)).toBe(false);
    expect(canScroll(box(400), -10)).toBe(true);
  });
});

describe("wheelPx", () => {
  it("lines and pages in px", () => {
    expect(wheelPx(3, 0, 200)).toBe(3);
    expect(wheelPx(3, 1, 200)).toBe(48);
    expect(wheelPx(1, 2, 200)).toBe(200);
  });
});

describe("forwardWheel", () => {
  it("a wheel over the bar scrolls the log", () => {
    expect(wheel({})).toBe(-100);
    expect(wheel({ deltaY: 40, log: box(100) })).toBe(40);
  });
  it("an input with text left to scroll keeps the wheel", () => {
    expect(wheel({ own: [box(50, 300, 100)] })).toBe(0);
  });
  it("the input at its own edge (or with no overflow) passes it on", () => {
    expect(wheel({ own: [box(0, 300, 100)] })).toBe(-100);
    expect(wheel({ own: [box(0, 34, 34)] })).toBe(-100);
  });
  it("the log at its end leaves the wheel to the page", () => {
    expect(wheel({ deltaY: 100, log: box(400) })).toBe(0);
    expect(wheel({ log: box(0) })).toBe(0);
    expect(wheel({ log: null })).toBe(0);
  });
  it("pinch zoom and sideways swipes are left alone", () => {
    expect(wheel({ ctrlKey: true })).toBe(0);
    expect(wheel({ deltaX: 200, deltaY: -10 })).toBe(0);
  });
});
