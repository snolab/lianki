import { describe, expect, it } from "bun:test";
import {
  attachMenuRoom,
  attachMenuShift,
  MIN_ROOM_ABOVE,
} from "@lianki/debug-chat/attach-menu-room";

describe("plus menu space at its button", () => {
  it("keeps the menu and close button within both horizontal edges", () => {
    expect(attachMenuShift({ left: 62, width: 374 }, { width: 390 })).toBe(-54);
    expect(attachMenuShift({ left: -10, width: 200 }, { width: 390 })).toBe(18);
    expect(attachMenuShift({ left: 20, width: 200 }, { width: 390 })).toBe(0);
    expect(attachMenuShift({ left: 62, width: 374 }, { width: 390, offsetLeft: 20 })).toBe(-34);
  });
  it("opens up at the initial phone bar, irrespective of its parent height", () => {
    expect(attachMenuRoom({ top: 713, bottom: 747 }, { height: 844 })).toEqual({
      down: false,
      px: 705,
    });
  });
  it("prefers up whenever the threshold is met, even with more room below", () => {
    expect(attachMenuRoom({ top: MIN_ROOM_ABOVE + 8, bottom: 202 }, { height: 844 })).toEqual({
      down: false,
      px: 160,
    });
  });
  it("goes down only with little room above and more below", () => {
    expect(attachMenuRoom({ top: 70, bottom: 110 }, { height: 844 })).toEqual({
      down: true,
      px: 726,
    });
    expect(attachMenuRoom({ top: 90, bottom: 130 }, { height: 220 })).toEqual({
      down: false,
      px: 82,
    });
  });
  it("clamps to the available space, with no minimum height that overflows", () => {
    expect(attachMenuRoom({ top: 20, bottom: 60 }, { height: 100 })).toEqual({
      down: true,
      px: 32,
    });
    expect(attachMenuRoom({ top: -30, bottom: 60 }, { height: 40 })).toEqual({
      down: false,
      px: 0,
    });
  });
  it("uses the visible viewport after the phone keyboard pans it", () => {
    expect(attachMenuRoom({ top: 220, bottom: 260 }, { height: 300, offsetTop: 200 })).toEqual({
      down: true,
      px: 232,
    });
    expect(attachMenuRoom({ top: 470, bottom: 510 }, { height: 350, offsetTop: 200 })).toEqual({
      down: false,
      px: 262,
    });
  });
});
