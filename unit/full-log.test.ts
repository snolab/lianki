import { describe, expect, it } from "bun:test";
import {
  FADE,
  FADE_SHORT,
  FULL_LOG_GAP_PX,
  fullLogHeight,
  keepEndGap,
  logSurface,
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
