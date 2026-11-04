import { describe, expect, it } from "bun:test";
import { placeBox } from "@lianki/debug-chat/anchor";

describe("placeBox", () => {
  const vw = 390;
  it("right: the box's right edge on the bar's", () => {
    const r = placeBox({ side: "right", barLeft: 262, barRight: 382, boxWidth: 200, vw });
    expect(r).toEqual({ side: "right", left: 182 });
  });
  it("left: left edges together, wherever the bar is on screen", () => {
    expect(placeBox({ side: "left", barLeft: 8, barRight: 128, boxWidth: 200, vw })).toEqual({
      side: "left",
      left: 8,
    });
    // In the right third (the old rule right-aligned it there): still from the pill's left.
    expect(placeBox({ side: "left", barLeft: 62, barRight: 160, boxWidth: 300, vw }).left).toBe(62);
  });
  it("center: centred on the bar", () => {
    expect(placeBox({ side: "center", barLeft: 135, barRight: 255, boxWidth: 200, vw })).toEqual({
      side: "center",
      left: 95,
    });
  });
  it("clamps inside the viewport, the safe areas and the gutter", () => {
    // Left-aligned from a pill near the right edge: pulled back on screen.
    expect(placeBox({ side: "left", barLeft: 300, barRight: 388, boxWidth: 374, vw }).left).toBe(8);
    // Right-aligned from a pill at the left edge: kept off it, gutter + inset.
    expect(
      placeBox({ side: "right", barLeft: 0, barRight: 120, boxWidth: 300, vw, insetLeft: 44 }).left,
    ).toBe(52);
    // Right inset (landscape notch).
    const r = placeBox({
      side: "left",
      barLeft: 280,
      barRight: 386,
      boxWidth: 200,
      vw,
      insetRight: 30,
    });
    expect(r.left + 200).toBeLessThanOrEqual(vw - 30 - 8);
    // Wider than the screen: pinned left.
    expect(placeBox({ side: "right", barLeft: 0, barRight: 100, boxWidth: 500, vw }).left).toBe(8);
  });
});
