import { describe, expect, it } from "bun:test";
import { type Axis } from "@snomiao/rgui/gantt";
import {
  GANTT_STATUS_COLORS,
  GANTT_STATUS_FALLBACK_LABELS,
  computeStateSegments,
  formatDuration,
  normalizeGanttStatus,
} from "../packages/debug-chat/src/gantt-states";
import {
  GANTT_COLORS,
  oklchToSrgb,
  over,
  parseOklch,
  srgbLuminance,
} from "../packages/debug-chat/src/gantt-view";
import type { EtaTask } from "../packages/debug-chat/src/eta";

const cr = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

describe("gantt status colors", () => {
  it("uses valid oklch colors with no red hues (reserved for now line)", () => {
    for (const [key, cols] of Object.entries(GANTT_STATUS_COLORS)) {
      for (const [theme, css] of Object.entries(cols)) {
        const oklch = parseOklch(css);
        expect(css).toMatch(/^oklch\(/);
        // Hue should not be red (0..40 or 350..360)
        const isRed = (oklch.h >= 0 && oklch.h <= 40) || oklch.h >= 350;
        expect(isRed).toBe(false);
      }
    }
  });

  it("satisfies WCAG AA text readability against track composited", () => {
    for (const theme of ["light", "dark"] as const) {
      const c = GANTT_COLORS[theme];
      const track = oklchToSrgb(parseOklch(c.track));
      for (const [st, cols] of Object.entries(GANTT_STATUS_COLORS)) {
        const bg = over(parseOklch(cols[theme]), track);
        for (const fg of [c.text, c.muted]) {
          const ratio = cr(srgbLuminance(oklchToSrgb(parseOklch(fg))), srgbLuminance(bg));
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        }
        // Shows against track
        expect(cr(srgbLuminance(bg), srgbLuminance(track))).toBeGreaterThan(1.05);
      }
    }
  });

  it("normalizes statuses into known keys", () => {
    expect(normalizeGanttStatus("doing")).toBe("doing");
    expect(normalizeGanttStatus("CI")).toBe("review");
    expect(normalizeGanttStatus("qa")).toBe("review");
    expect(normalizeGanttStatus("test")).toBe("review");
    expect(normalizeGanttStatus("review")).toBe("review");
    expect(normalizeGanttStatus("waiting")).toBe("waiting");
    expect(normalizeGanttStatus("waiting-owner")).toBe("waiting-owner");
    expect(normalizeGanttStatus("blocked")).toBe("blocked");
    expect(normalizeGanttStatus("done")).toBe("done");
    expect(normalizeGanttStatus("unknown")).toBe("doing");
  });

  it("formats duration gracefully", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(45000)).toBe("45s");
    expect(formatDuration(60000)).toBe("1M");
    expect(formatDuration(3600000)).toBe("1H");
  });
});

describe("computeStateSegments", () => {
  const axis: Axis = { lo: 0, hi: 100_000, pxPerMs: 0.01 };
  const now = 50_000;

  it("returns single segment when task has no status ticks", () => {
    const task: EtaTask = {
      id: "t1",
      title: "test: simple task",
      start: 10_000,
      at: 30_000,
      done: false,
    };
    const segments = computeStateSegments(task, axis, now);
    expect(segments.length).toBe(1);
    expect(segments[0]!.status).toBe("doing");
    expect(segments[0]!.from).toBe(10_000);
    expect(segments[0]!.to).toBe(30_000);
    expect(segments[0]!.duration).toBe(20_000);
  });

  it("segments task by status ticks in order", () => {
    const task: EtaTask = {
      id: "t2",
      title: "test: multi state task",
      start: 0,
      at: 40_000,
      done: true,
      doneAt: 40_000,
      ticks: [
        { at: 10_000, kind: "status", changeId: "c1", by: "agy", status: "review" },
        { at: 25_000, kind: "status", changeId: "c2", by: "agy", status: "waiting-owner" },
      ],
    };
    const segments = computeStateSegments(task, axis, now);
    expect(segments.length).toBe(3);
    expect(segments[0]!.status).toBe("doing");
    expect(segments[0]!.from).toBe(0);
    expect(segments[0]!.to).toBe(10_000);

    expect(segments[1]!.status).toBe("review");
    expect(segments[1]!.from).toBe(10_000);
    expect(segments[1]!.to).toBe(25_000);

    expect(segments[2]!.status).toBe("done"); // finished
    expect(segments[2]!.from).toBe(25_000);
    expect(segments[2]!.to).toBe(40_000);
  });

  it("merges adjacent identical status ticks", () => {
    const task: EtaTask = {
      id: "t3",
      title: "test: dup state task",
      start: 0,
      at: 30_000,
      ticks: [
        { at: 10_000, kind: "status", changeId: "c1", by: "agy", status: "doing" },
        { at: 20_000, kind: "status", changeId: "c2", by: "agy", status: "doing" },
      ],
    };
    const segments = computeStateSegments(task, axis, now);
    expect(segments.length).toBe(1);
    expect(segments[0]!.status).toBe("doing");
    expect(segments[0]!.from).toBe(0);
    expect(segments[0]!.to).toBe(30_000);
  });
});
