import { describe, expect, it } from "bun:test";
import {
  type FoldState,
  HANDLE_SIZE,
  floatSide,
  foldNext,
  handleTop,
  handleTouch,
  mirrorShift,
  nearestEdge,
  pushedAgainst,
  TOUCH_INSET,
} from "@lianki/debug-chat/fold";

const at = (fold: FoldState["fold"], edge: FoldState["edge"] = "right"): FoldState => ({
  fold,
  edge,
});

describe("foldNext", () => {
  it("the mark folds one step at a time: open → pill → tucked", () => {
    expect(foldNext(at("open"), { type: "mark" })).toEqual(at("pill"));
    expect(foldNext(at("pill"), { type: "mark" })).toEqual(at("tucked"));
    expect(foldNext(at("pill", "left"), { type: "mark" })).toEqual(at("tucked", "left"));
  });
  it("the handle brings the pill back, never the full chat", () => {
    expect(foldNext(at("tucked"), { type: "handle" })).toEqual(at("pill"));
    expect(foldNext(at("open"), { type: "handle" })).toEqual(at("open"));
  });
  it("restore opens from any fold; minimize only folds an open chat", () => {
    for (const f of ["open", "pill", "tucked"] as const)
      expect(foldNext(at(f, "left"), { type: "restore" })).toEqual(at("open", "left"));
    expect(foldNext(at("open"), { type: "minimize" })).toEqual(at("pill"));
    expect(foldNext(at("tucked"), { type: "minimize" })).toEqual(at("tucked"));
  });
  it("a pill pushed against an edge tucks into that edge", () => {
    expect(foldNext(at("pill"), { type: "dropped", nearest: "left", against: "left" })).toEqual(
      at("tucked", "left"),
    );
  });
  it("any other drop only follows the nearest edge (mirroring on the left)", () => {
    expect(foldNext(at("pill"), { type: "dropped", nearest: "left", against: null })).toEqual(
      at("pill", "left"),
    );
    // An open bar against the edge does not tuck.
    expect(foldNext(at("open"), { type: "dropped", nearest: "right", against: "right" })).toEqual(
      at("open", "right"),
    );
  });
});

describe("edges", () => {
  it("nearest edge by the box's centre", () => {
    expect(nearestEdge(0, 128, 390)).toBe("left");
    expect(nearestEdge(250, 378, 390)).toBe("right");
    // Centre exactly in the middle: the right, the default.
    expect(nearestEdge(130, 260, 390)).toBe("right");
  });
  it("pushed against an edge only when flush with it", () => {
    expect(pushedAgainst(0, 120, 390)).toBe("left");
    expect(pushedAgainst(270, 390, 390)).toBe("right");
    expect(pushedAgainst(8, 128, 390)).toBeNull();
    expect(pushedAgainst(262, 382, 390)).toBeNull();
  });
  it("the floating lines align from the pill's side, not the screen third", () => {
    expect(floatSide("right")).toBe("left");
    expect(floatSide("left")).toBe("right");
  });
});

describe("mirrorShift", () => {
  const d = { boxWidth: 320, pillWidth: 128 };
  it("keeps a minimized pill in place when the box mirrors", () => {
    expect(mirrorShift({ ...d, from: "right", to: "left", fold: "pill" })).toBe(-192);
    expect(mirrorShift({ ...d, from: "left", to: "right", fold: "tucked" })).toBe(192);
  });
  it("nothing moves open, or when the edge stays", () => {
    expect(mirrorShift({ ...d, from: "right", to: "left", fold: "open" })).toBe(0);
    expect(mirrorShift({ ...d, from: "left", to: "left", fold: "pill" })).toBe(0);
  });
});

describe("handle", () => {
  it("both shapes are thumb-sized, their touch area off the Back-gesture edge", () => {
    for (const shape of ["half", "square"] as const) {
      const t = handleTouch(shape);
      expect(t.inset).toBe(TOUCH_INSET);
      expect(t.width).toBeGreaterThanOrEqual(44);
      expect(HANDLE_SIZE[shape].h).toBeGreaterThanOrEqual(44);
    }
  });
  it("centred on the pill, kept inside the safe area", () => {
    expect(handleTop({ centerY: 800, height: 88, vh: 844 })).toBe(756);
    expect(handleTop({ centerY: 840, height: 88, vh: 844, safeBottom: 34 })).toBe(722);
    expect(handleTop({ centerY: 10, height: 88, vh: 844, safeTop: 47 })).toBe(47);
  });
});
