import { describe, expect, test } from "bun:test";
import {
  RATE_CEIL,
  RATE_FLOOR,
  heatmapBuckets,
  maturityLabel,
  maturityScore,
  rateColor,
  rateSegments,
  videoDifficulty,
} from "@lianki/core";

describe("rateSegments", () => {
  test("a marker holds until the next one; before the first it is 1.0", () => {
    expect(rateSegments({ 10: 0.7, 30: 1.5 }, 60)).toEqual([
      { from: 0, to: 10, rate: 1 },
      { from: 10, to: 30, rate: 0.7 },
      { from: 30, to: 60, rate: 1.5 },
    ]);
  });

  test("no markers means the whole video at 1.0", () => {
    expect(rateSegments({}, 60)).toEqual([{ from: 0, to: 60, rate: 1 }]);
    expect(rateSegments(undefined, 60)).toEqual([{ from: 0, to: 60, rate: 1 }]);
  });

  test("a marker at 0 replaces the default opening segment", () => {
    expect(rateSegments({ 0: 0.8 }, 30)).toEqual([{ from: 0, to: 30, rate: 0.8 }]);
  });

  test("markers past the end are ignored, not extrapolated", () => {
    expect(rateSegments({ 90: 2 }, 60)).toEqual([{ from: 0, to: 60, rate: 1 }]);
  });

  test("unsorted and malformed input is tolerated", () => {
    expect(rateSegments({ 30: 1.5, 10: 0.7 }, 60)[1]).toEqual({ from: 10, to: 30, rate: 0.7 });
    expect(rateSegments({ 10: 0, 20: -1, 30: NaN, x: 2 } as never, 60)).toEqual([
      { from: 0, to: 60, rate: 1 },
    ]);
  });

  test("a zero or unknown duration yields nothing to draw", () => {
    expect(rateSegments({ 10: 2 }, 0)).toEqual([]);
    expect(rateSegments({ 10: 2 }, NaN)).toEqual([]);
  });
});

describe("maturityScore", () => {
  test("is the GEOMETRIC mean — half and double speed must cancel to 1.0", () => {
    const segments = rateSegments({ 0: 0.5, 30: 2 }, 60);
    expect(maturityScore(segments)).toBeCloseTo(1, 6);
    // The arithmetic mean would score this struggle 1.25 and call it comfortable.
    expect((0.5 + 2) / 2).toBe(1.25);
  });

  test("weights by time, not by marker count", () => {
    // One brief slow patch shouldn't outvote fifty comfortable minutes.
    const brief = maturityScore(rateSegments({ 0: 1.5, 3000: 0.5, 3001: 1.5 }, 3060));
    expect(brief).toBeGreaterThan(1.4);
  });

  test("an unmarked video scores exactly neutral", () => {
    expect(maturityScore(rateSegments({}, 60))).toBe(1);
    expect(maturityScore([])).toBe(1);
  });

  test("extreme rates are clamped rather than allowed to dominate", () => {
    expect(maturityScore(rateSegments({ 0: 16 }, 60))).toBeCloseTo(RATE_CEIL, 6);
    expect(maturityScore(rateSegments({ 0: 0.05 }, 60))).toBeCloseTo(RATE_FLOOR, 6);
  });
});

describe("heatmapBuckets", () => {
  test("returns one value per bucket, ordered along the timeline", () => {
    const segments = rateSegments({ 0: 2, 50: 0.5 }, 100);
    const buckets = heatmapBuckets(segments, 100, 10);
    expect(buckets.length).toBe(10);
    expect(buckets[0]).toBeCloseTo(2, 6);
    expect(buckets[9]).toBeCloseTo(0.5, 6);
  });

  test("a short slow passage survives downsampling instead of being skipped", () => {
    // 2 s of 0.5x inside a 200 s video, with only 10 buckets: midpoint sampling
    // would miss it entirely. Overlap weighting must still bend its bucket down.
    const segments = rateSegments({ 100: 0.5, 102: 1 }, 200);
    const buckets = heatmapBuckets(segments, 200, 10);
    expect(buckets[5]).toBeLessThan(1);
  });

  test("degenerate inputs return nothing rather than throwing", () => {
    expect(heatmapBuckets([], 0, 10)).toEqual([]);
    expect(heatmapBuckets([], 100, 0)).toEqual([]);
  });

  test("gaps with no coverage read as neutral", () => {
    expect(heatmapBuckets([{ from: 0, to: 10, rate: 2 }], 100, 10)[9]).toBe(1);
  });
});

describe("rateColor", () => {
  /** oklch(L C H / a) */
  const parse = (c: string) => {
    const m = c.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+) \/ ([\d.]+)\)/);
    if (!m) throw new Error(`not oklch: ${c}`);
    return { l: +m[1], c: +m[2], h: +m[3], a: +m[4] };
  };

  test("emits oklch, not hsl — perceptually uniform so the two ends match", () => {
    expect(rateColor(1.5)).toMatch(/^oklch\(/);
    expect(rateColor(0.7)).not.toMatch(/hsla?\(/);
  });

  test("neutral is near-greyscale, not a mid-spectrum warning colour", () => {
    expect(parse(rateColor(1)).c).toBeLessThan(0.02);
    expect(parse(rateColor(1.01)).c).toBeLessThan(0.02);
  });

  test("faster is green, slower is red", () => {
    expect(parse(rateColor(1.6)).h).toBe(148);
    expect(parse(rateColor(0.6)).h).toBe(27);
  });

  test("chroma grows with distance from neutral", () => {
    expect(parse(rateColor(2)).c).toBeGreaterThan(parse(rateColor(1.2)).c);
    expect(parse(rateColor(0.5)).c).toBeGreaterThan(parse(rateColor(0.85)).c);
  });

  test("equal-magnitude deviations are equally intense in both directions", () => {
    // 0.5x and 2x are the same distance from 1.0 in log space; with hsl their
    // fixed lightness made one look far louder than the other.
    expect(parse(rateColor(2)).c).toBeCloseTo(parse(rateColor(0.5)).c, 6);
    expect(parse(rateColor(2)).l).toBeCloseTo(parse(rateColor(0.5)).l, 6);
  });

  test("alpha passes through", () => {
    expect(parse(rateColor(1, 0.5)).a).toBe(0.5);
    expect(parse(rateColor(1.8, 0.25)).a).toBe(0.25);
  });
});

describe("videoDifficulty", () => {
  test("`marked` counts only deliberate changes, not the 1.0 default", () => {
    const d = videoDifficulty({ 0: 1, 30: 0.7 }, 60);
    expect(d.marked).toBeCloseTo(0.5, 6);
  });

  test("an untouched video reports zero marked, so callers can stay silent", () => {
    expect(videoDifficulty({}, 60).marked).toBe(0);
  });

  test("labels move monotonically with the score", () => {
    expect(maturityLabel(1.5)).toBe("comfortable");
    expect(maturityLabel(1.1)).toBe("easy");
    expect(maturityLabel(1)).toBe("steady");
    expect(maturityLabel(0.9)).toBe("effortful");
    expect(maturityLabel(0.6)).toBe("hard");
  });
});
