import { describe, expect, it } from "bun:test";
import {
  FADE,
  FADE_SHORT,
  FULL_LOG_GAP_PX,
  fullLogHeight,
  keepEndGap,
  fullLogBox,
  logSurface,
  snapAxis,
} from "@lianki/debug-chat/log-surface";

describe("fullLogHeight", () => {
  it("grows the log up to the visible top, below the notch", () => {
    // Log bottom just above the bar at 790; the notch is 47 px.
    expect(fullLogHeight({ bottom: 790, height: 70, safeTop: 47 })).toBe(
      790 - 47 - FULL_LOG_GAP_PX,
    );
  });

  it("with the keyboard panned in, stops at the visible top instead", () => {
    expect(fullLogHeight({ bottom: 460, height: 70, safeTop: 47, vvTop: 200 })).toBe(460 - 208);
  });

  it("never shrinks it", () => {
    expect(fullLogHeight({ bottom: 60, height: 50, safeTop: 47 })).toBe(50);
  });
});

describe("logSurface", () => {
  it("compact at rest, 30vh open; the fade mask only once it overflows", () => {
    const rest = logSurface({ expanded: false, fade: false });
    expect(rest.className).toContain("max-h-[4.4rem]");
    expect(rest.style).toBeUndefined();
    const open = logSurface({ expanded: true, fade: true });
    expect(open.className).toContain("max-h-[30vh]");
    expect(open.style?.maskImage).toBe(FADE);
    expect(logSurface({ expanded: false, fade: true }).style?.maskImage).toBe(FADE_SHORT);
  });
});

describe("keepEndGap", () => {
  it("keeps the lines at the bottom edge where they were when the log grows", () => {
    // 1000 px of lines, the view 70 tall, 100 px below it: now 700 tall.
    expect(keepEndGap({ scrollHeight: 1000, clientHeight: 700, gap: 100 })).toBe(200);
  });

  it("at the end stays at the end; past the top clamps to 0", () => {
    expect(keepEndGap({ scrollHeight: 1000, clientHeight: 700, gap: 0 })).toBe(300);
    expect(keepEndGap({ scrollHeight: 1000, clientHeight: 700, gap: 500 })).toBe(0);
    expect(keepEndGap({ scrollHeight: 1000, clientHeight: 700, gap: -3 })).toBe(300);
  });
});

describe("size-snapping (snapAxis, fullLogBox)", () => {
  it("snapAxis: the screen size below the threshold, the own size from it on", () => {
    expect(snapAxis(374, 320, 624)).toBe(374);
    expect(snapAxis(820, 320, 624)).toBe(320);
    expect(snapAxis(624, 320, 624)).toBe(320); // at the threshold: kept
  });

  const safe = { top: 47, right: 0, bottom: 34, left: 0 };
  const log = { left: 62, width: 320, bottom: 790, height: 70 };

  it("a phone held upright: edge to edge, full height, the bar aside", () => {
    const b = fullLogBox({ vw: 390, vh: 844, visibleTop: 0, visibleBottom: 844, safe, log });
    expect(b).toEqual({ left: 8, width: 374, top: 55, bottom: 802, hideBar: true });
  });

  it("wider (a phone on its side, a tablet): its own width, full height above the bar", () => {
    const side = fullLogBox({
      vw: 844,
      vh: 390,
      visibleTop: 0,
      visibleBottom: 390,
      safe: { top: 0, right: 47, bottom: 21, left: 47 },
      log: { left: 470, width: 320, bottom: 330, height: 70 },
    });
    expect(side).toEqual({ left: 470, width: 320, top: 8, bottom: 330, hideBar: false });
    const tablet = fullLogBox({
      vw: 1024,
      vh: 1366,
      visibleTop: 0,
      visibleBottom: 1366,
      safe: { top: 24, right: 0, bottom: 20, left: 0 },
      log: { left: 690, width: 320, bottom: 1300, height: 70 },
    });
    expect(tablet).toMatchObject({ width: 320, top: 32, bottom: 1300, hideBar: false });
  });

  it("with the keyboard up, it stops at the visible area", () => {
    const b = fullLogBox({ vw: 390, vh: 844, visibleTop: 0, visibleBottom: 508, safe, log });
    expect(b).toMatchObject({ top: 55, bottom: 500, hideBar: true });
  });
});
