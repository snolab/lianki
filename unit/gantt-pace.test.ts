import { describe, expect, it } from "bun:test";
import {
  GANTT_COLORS,
  GANTT_PACE_MARGIN_PX,
  LIVE_ATTR,
  LIVE_CSS,
  PACE_COLORS,
  oklchToSrgb,
  paceColor,
  paceOf,
  parseOklch,
  srgbLuminance,
} from "@lianki/debug-chat/gantt-view";

const ratio = (a: string, b: string) => {
  const la = srgbLuminance(oklchToSrgb(parseOklch(a)));
  const lb = srgbLuminance(oklchToSrgb(parseOklch(b)));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

describe("the reported-progress underline (owner, 2026-11-10)", () => {
  it("behind when its end is left of Now past the margin, ahead when right of it", () => {
    expect(paceOf(100, 200)).toBe("behind");
    expect(paceOf(300, 200)).toBe("ahead");
    expect(paceOf(200 - GANTT_PACE_MARGIN_PX, 200)).toBe("on");
    expect(paceOf(200 + GANTT_PACE_MARGIN_PX, 200)).toBe("on");
  });

  it("each tint is at least 3:1 against the track, light and dark (non-text)", () => {
    for (const theme of ["light", "dark"] as const)
      for (const v of Object.values(PACE_COLORS[theme]))
        expect(ratio(v, GANTT_COLORS[theme].track)).toBeGreaterThanOrEqual(3);
    expect(paceColor("behind")).toBe(
      `light-dark(${PACE_COLORS.light.behind}, ${PACE_COLORS.dark.behind})`,
    );
  });

  it("live: a pulse; reduced motion or animations off: still, the line dashed", () => {
    expect(LIVE_CSS).toContain("@keyframes lk-gantt-live");
    expect(LIVE_CSS).toContain(`[${LIVE_ATTR}]{animation:lk-gantt-live`);
    expect(LIVE_CSS).toContain("prefers-reduced-motion: reduce");
    expect(LIVE_CSS).toContain("repeating-linear-gradient");
    expect(LIVE_CSS).toContain('html[data-motion="off"]');
    expect(LIVE_CSS).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });
});
