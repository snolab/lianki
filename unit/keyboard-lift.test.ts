import { describe, expect, it } from "bun:test";
import { KEYBOARD_GAP_PX, keyboardLift } from "@lianki/debug-chat/keyboard-lift";

// An iPhone in portrait: 844 layout px, the bar resting 48 px tall above the
// home indicator (bottom 844 − 8 − 34 = 802).
const bar = { barTop: 754, barBottom: 802 };

describe("keyboardLift", () => {
  it("is 0 with no keyboard (the visual viewport is the whole screen)", () => {
    expect(keyboardLift({ ...bar, vvTop: 0, vvHeight: 844 })).toBe(0);
  });

  it("lifts a covered bar to sit the gap above the keyboard", () => {
    // Keyboard 336 px: visible 0..508. Bar bottom must be 500.
    expect(keyboardLift({ ...bar, vvTop: 0, vvHeight: 508 })).toBe(802 + KEYBOARD_GAP_PX - 508);
  });

  it("leaves it alone once iOS scrolled the input into view", () => {
    // iOS panned the visual viewport down 336 px: the bar is visible already.
    expect(keyboardLift({ ...bar, vvTop: 336, vvHeight: 508 })).toBe(0);
    // Half way through that pan: only the rest is lifted.
    expect(keyboardLift({ ...bar, vvTop: 200, vvHeight: 508 })).toBe(802 + 8 - 708);
  });

  it("a bar dragged high, above the keyboard, is not moved", () => {
    expect(keyboardLift({ barTop: 300, barBottom: 348, vvTop: 0, vvHeight: 508 })).toBe(0);
  });

  it("never lifts above the visible top or under the notch", () => {
    // A tiny visible area (landscape + keyboard): the top edge stays in view.
    expect(keyboardLift({ ...bar, vvTop: 0, vvHeight: 40, safeTop: 47 })).toBe(754 - 47);
    expect(keyboardLift({ ...bar, vvTop: 100, vvHeight: 40 })).toBe(754 - 108);
    // Already at the limit: nothing to give.
    expect(keyboardLift({ barTop: 40, barBottom: 88, vvTop: 0, vvHeight: 60, safeTop: 47 })).toBe(
      0,
    );
  });

  it("ignores a pinch zoom (the user's view, not a keyboard)", () => {
    expect(keyboardLift({ ...bar, vvTop: 0, vvHeight: 300, vvScale: 2 })).toBe(0);
  });

  it("rounds to whole px and honours a custom gap", () => {
    expect(keyboardLift({ ...bar, vvTop: 0, vvHeight: 508.4, gap: 0 })).toBe(294);
  });
});
