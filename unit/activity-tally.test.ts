import { describe, expect, it } from "bun:test";
import { formatDate, getMonthLabel, TALLY_STROKES, tallyStrokes } from "@/app/lib/heatmap-utils";

describe("tallyStrokes: 正 strokes by the learner's own quantiles", () => {
  it("gives empty days no mark", () => {
    expect(tallyStrokes({ "2026-11-01": 0, "2026-11-02": 4 })).toEqual({ "2026-11-02": 3 });
  });

  it("spreads strokes 1–5 over the learner's own range", () => {
    const data = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")}`, i + 1]),
    );
    const s = tallyStrokes(data);
    expect(s["2026-10-01"]).toBe(1);
    expect(s["2026-10-10"]).toBe(5);
    const values = Object.values(s);
    expect(new Set(values)).toEqual(new Set([1, 2, 3, 4, 5]));
    // monotone: more reviews never means fewer strokes
    for (let i = 1; i < 10; i++)
      expect(s[`2026-10-${String(i + 1).padStart(2, "0")}`]).toBeGreaterThanOrEqual(
        s[`2026-10-${String(i).padStart(2, "0")}`],
      );
  });

  it("has no built-in threshold: the same shape at any scale", () => {
    const small = tallyStrokes({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    const big = tallyStrokes({ a: 100, b: 200, c: 300, d: 400, e: 500 });
    expect(big).toEqual(small);
  });

  it("gives equal days equal strokes (all alike: the middle, 3)", () => {
    expect(tallyStrokes({ a: 7, b: 7, c: 7 })).toEqual({ a: 3, b: 3, c: 3 });
  });

  it("draws 正 in five strokes", () => {
    expect(TALLY_STROKES).toHaveLength(5);
  });
});

describe("the chart's dates follow the reader's locale", () => {
  it("formats a day unambiguously", () => {
    expect(formatDate("2026-11-10", "en")).toBe("Nov 10, 2026");
    expect(formatDate("2026-11-10", "ja")).toContain("2026");
  });

  it("labels a week only where the month changes", () => {
    const start = new Date(2026, 0, 1);
    expect(getMonthLabel(0, start, "en")).toBe("Jan");
    expect(getMonthLabel(1, start, "en")).toBeNull();
    expect(getMonthLabel(5, start, "en")).toBe("Feb");
  });
});
