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
  anchorScrollTop,
  fullLogPad,
  fitTreePanel,
  pickAnchor,
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

  const safe = { top: 47, bottom: 34 };
  const log = { left: 62, width: 320, bottom: 790, height: 70 };

  it("never changes the width: only the height, top to bottom of the visible area", () => {
    const phone = fullLogBox({ vh: 844, visibleTop: 0, visibleBottom: 844, safe, log });
    expect(phone).toEqual({ left: 62, width: 320, top: 55, bottom: 802, hideBar: true });
    const side = fullLogBox({
      vh: 390,
      visibleTop: 0,
      visibleBottom: 390,
      safe: { top: 0, bottom: 21 },
      log: { left: 470, width: 320, bottom: 330, height: 70 },
    });
    expect(side).toEqual({ left: 470, width: 320, top: 8, bottom: 361, hideBar: true });
    const tablet = fullLogBox({
      vh: 1366,
      visibleTop: 0,
      visibleBottom: 1366,
      safe: { top: 24, bottom: 20 },
      log: { left: 690, width: 320, bottom: 1300, height: 70 },
    });
    expect(tablet).toEqual({ left: 690, width: 320, top: 32, bottom: 1338, hideBar: true });
  });

  it("with the keyboard up, it stops at the visible area", () => {
    const b = fullLogBox({ vh: 844, visibleTop: 0, visibleBottom: 508, safe, log });
    expect(b).toMatchObject({ width: 320, top: 55, bottom: 500 });
  });
});

describe("keeping the line being read in place (pickAnchor, anchorScrollTop, fullLogPad)", () => {
  const rows = [
    { id: "a", top: 100, bottom: 120 },
    { id: "b", top: 122, bottom: 142 },
    { id: "c", top: 144, bottom: 164 },
  ];
  it("pickAnchor: the line under the focus line, else the nearest", () => {
    expect(pickAnchor(rows, 130)?.id).toBe("b");
    expect(pickAnchor(rows, 143)?.id).toBe("b"); // in the gap: the nearer edge
    expect(pickAnchor(rows, 10)?.id).toBe("a");
    expect(pickAnchor(rows, 900)?.id).toBe("c");
    expect(pickAnchor([], 100)).toBeNull();
  });

  it("anchorScrollTop: back to its old top when the view reaches it", () => {
    // Entering full screen: the line moved down 300 px; scroll it back up there.
    expect(
      anchorScrollTop({
        before: 780,
        after: 1080,
        height: 20,
        view: { top: 8, bottom: 900 },
        scrollTop: 500,
        maxScroll: 5000,
      }),
    ).toBe(800);
  });

  it("anchorScrollTop: into the view's nearest edge when it no longer reaches there", () => {
    // Leaving: the compact log is 790..860; a line read at 300 lands at its top.
    expect(
      anchorScrollTop({
        before: 300,
        after: 1200,
        height: 20,
        view: { top: 790, bottom: 860 },
        scrollTop: 100,
        maxScroll: 5000,
      }),
    ).toBe(510);
    // Clamped to the scroll range.
    expect(
      anchorScrollTop({
        before: 300,
        after: 0,
        height: 20,
        view: { top: 790, bottom: 860 },
        scrollTop: 100,
        maxScroll: 5000,
      }),
    ).toBe(0);
  });

  it("fullLogPad: 0.45 of the height above the first line and below the last", () => {
    expect(fullLogPad(800)).toBe(360);
  });
});

describe("fitTreePanel (the expanded tree, always inside the visible area)", () => {
  it("room above the log: its full height, in the flow", () => {
    expect(fitTreePanel({ flowBottom: 784, visibleTop: 0, visibleBottom: 902, want: 361 })).toEqual(
      {
        mode: "flow",
        height: 361,
      },
    );
  });
  it("less room (keyboard up, a tall log): shortened to reach the visible top", () => {
    expect(fitTreePanel({ flowBottom: 161, visibleTop: 0, visibleBottom: 480, want: 361 })).toEqual(
      {
        mode: "flow",
        height: 153,
      },
    );
    // Below the notch.
    expect(
      fitTreePanel({ flowBottom: 400, visibleTop: 47, visibleBottom: 902, want: 361 }),
    ).toEqual({ mode: "flow", height: 345 });
  });
  it("hardly any room: an overlay at the visible top, as tall as fits", () => {
    expect(fitTreePanel({ flowBottom: 60, visibleTop: 0, visibleBottom: 480, want: 361 })).toEqual({
      mode: "overlay",
      top: 8,
      height: 361,
    });
    expect(
      fitTreePanel({ flowBottom: 60, visibleTop: 100, visibleBottom: 300, want: 361 }),
    ).toEqual({ mode: "overlay", top: 108, height: 184 });
  });
});
