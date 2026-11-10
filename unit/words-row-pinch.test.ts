import { describe, expect, test } from "bun:test";
import { CONFIG } from "@/lib/config";
import { rowMetrics } from "@/lib/words/row-layout";
import {
  anchoredScroll,
  anchorFrac,
  asFactor,
  backAvail,
  backLines,
  easeToward,
  levelHeight,
  linesToShow,
  minJerk,
  pinchBounds,
  pinchHeight,
  pinchRatio,
  rowHeightFor,
  settleHeight,
  toFactor,
  verticalSpan,
} from "@/lib/words/row-pinch";

describe("row-pinch: the default rows are unchanged", () => {
  test("touch 66px: two lines of example, one of meaning", () => {
    const { rowH } = rowMetrics(true, 1);
    expect(backAvail(rowH, 1, true)).toBe(3);
    expect(backLines(3, true)).toEqual({ first: 2, second: 1 });
  });
  test("the reader's review (one line more): three and one", () => {
    const { rowH } = rowMetrics(true, 1, 1);
    expect(backAvail(rowH, 1, true)).toBe(4);
    expect(backLines(4, true)).toEqual({ first: 3, second: 1 });
  });
  test("desk 42px: two lines a column; 60px: three", () => {
    expect(backAvail(rowMetrics(false, 1).rowH, 1, false)).toBe(2);
    expect(backAvail(rowMetrics(false, 1, 1).rowH, 1, false)).toBe(3);
    expect(backLines(2, false)).toEqual({ first: 2, second: 2 });
  });
  test("every text size keeps the default's lines", () => {
    for (const k of [1, 1.1, 1.2, 1.3, 1.4, 1.5]) {
      for (const touch of [true, false]) {
        const want = touch ? 3 : 2;
        expect(backAvail(rowMetrics(touch, k).rowH, k, touch)).toBe(want);
        expect(backAvail(rowMetrics(touch, k, 1).rowH, k, touch)).toBe(want + 1);
      }
    }
  });
});

describe("row-pinch: levels", () => {
  test("heights grow with each line, the word alone is the shortest", () => {
    for (const touch of [true, false]) {
      let last = 0;
      for (let n = 0; n < 12; n++) {
        const h = levelHeight(n, 1, touch);
        expect(h).toBeGreaterThan(last);
        last = h;
      }
    }
  });
  test("a level's own height has room for exactly its lines", () => {
    for (const k of [1, 1.3]) {
      for (const touch of [true, false]) {
        for (let n = 0; n < 10; n++)
          expect(backAvail(Math.round(levelHeight(n, k, touch)), k, touch)).toBe(n);
      }
    }
  });
  test("below one line, the word alone", () => {
    expect(backAvail(levelHeight(0, 1, true), 1, true)).toBe(0);
    expect(backLines(0, true)).toEqual({ first: 0, second: 0 });
    expect(backLines(1, true)).toEqual({ first: 1, second: 0 });
  });
  test("lines beyond the default are shared, the first takes the odd one", () => {
    expect(backLines(4, true)).toEqual({ first: 3, second: 1 });
    expect(backLines(5, true)).toEqual({ first: 3, second: 2 });
    expect(backLines(8, true)).toEqual({ first: 5, second: 3 });
  });
});

describe("row-pinch: bounds from the content", () => {
  test("touch: the fewest lines that show both cells in full", () => {
    expect(linesToShow({ first: 1, second: 1 }, true)).toBe(2);
    expect(linesToShow({ first: 2, second: 1 }, true)).toBe(3);
    expect(linesToShow({ first: 4, second: 1 }, true)).toBe(6);
    expect(linesToShow({ first: 2, second: 3 }, true)).toBe(7);
    expect(linesToShow({ first: 1, second: 0 }, true)).toBe(1);
  });
  test("desk: the taller column", () => {
    expect(linesToShow({ first: 4, second: 2 }, false)).toBe(4);
  });
  test("the tallest row on screen sets the top; the word alone the bottom", () => {
    const b = pinchBounds(
      [
        { first: 1, second: 1 },
        { first: 5, second: 1 },
      ],
      1,
      true,
      66,
    );
    expect(b.min).toBe(levelHeight(0, 1, true));
    expect(b.max).toBe(levelHeight(linesToShow({ first: 5, second: 1 }, true), 1, true));
  });
  test("short cards never pull the row in at the start", () => {
    const b = pinchBounds([{ first: 1, second: 0 }], 1, true, 66);
    expect(b.max).toBe(66);
  });
});

describe("row-pinch: the gesture", () => {
  const bounds = { min: 26, max: 200 };
  test("the spread scales the start height", () => {
    expect(pinchHeight(66, 100, 150, bounds)).toBe(99);
    expect(pinchHeight(66, 100, 50, bounds)).toBe(33);
  });
  test("clamped to the bounds", () => {
    expect(pinchHeight(66, 100, 10, bounds)).toBe(26);
    expect(pinchHeight(66, 100, 1000, bounds)).toBe(200);
  });
  test("a zero span changes nothing", () => {
    expect(pinchHeight(66, 0, 50, bounds)).toBe(66);
  });
  test("fingers side by side: the span has a floor", () => {
    expect(verticalSpan([300, 302], 24)).toBe(24);
    expect(verticalSpan([100, 300], 24)).toBe(200);
  });
  test("settles on the nearest level, and home on the default exactly", () => {
    const def = 66;
    expect(settleHeight(67, 1, true, def, bounds)).toBe(66);
    expect(settleHeight(84, 1, true, def, bounds)).toBe(levelHeight(4, 1, true));
    expect(settleHeight(27, 1, true, def, bounds)).toBe(levelHeight(0, 1, true));
    // Never past the content's top.
    expect(settleHeight(199, 1, true, def, { min: 26, max: 100 })).toBeLessThanOrEqual(101);
  });
  test("the settle curve starts and ends still", () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    expect(minJerk(0.5)).toBeCloseTo(0.5);
  });
});

describe("row-pinch: the stored factor", () => {
  test("round trip through a factor keeps the level", () => {
    for (const touch of [true, false]) {
      const def = rowMetrics(touch, 1).rowH;
      for (let n = 0; n < 10; n++) {
        const h = levelHeight(n, 1, touch);
        const back = rowHeightFor(def, toFactor(h, def));
        expect(backAvail(back, 1, touch)).toBe(n);
      }
    }
  });
  test("factor 1 is the default height exactly", () => {
    expect(rowHeightFor(66, 1)).toBe(66);
    expect(toFactor(66, 66)).toBe(1);
  });
  test("a bad stored value reads as the default", () => {
    expect(asFactor("x")).toBe(1);
    expect(asFactor(-1)).toBe(1);
    expect(asFactor(99)).toBe(1);
    expect(asFactor("1.5")).toBe(1.5);
  });
});

describe("row-pinch: a calm feel (owner, 2026-11-10: far too sensitive)", () => {
  const bounds = { min: 26, max: 400 };
  const calm = {
    gain: CONFIG["words.pinchGainPct"].default / 100,
    deadZone: CONFIG["words.pinchDeadZonePct"].default / 100,
  };
  test("the default gain is well below the plain spread", () => {
    expect(calm.gain).toBeLessThan(0.6);
    // Fingers twice as far apart: much less than twice the height.
    const h = pinchHeight(66, 100, 200, bounds, calm);
    expect(h).toBeGreaterThan(66);
    expect(h).toBeLessThan(66 * 1.4);
    expect(pinchHeight(66, 100, 200, bounds)).toBe(132);
  });
  test("a small finger wobble moves nothing (dead zone)", () => {
    expect(pinchRatio(100, 100 * (1 + calm.deadZone * 0.9), calm)).toBe(1);
    expect(pinchRatio(100, 100 / (1 + calm.deadZone * 0.9), calm)).toBe(1);
    expect(pinchRatio(100, 100 * (1 + calm.deadZone * 2), calm)).toBeGreaterThan(1);
  });
  test("no jump at the edge of the dead zone: continuous", () => {
    const edge = 100 * (1 + calm.deadZone);
    expect(pinchRatio(100, edge + 0.01, calm)).toBeCloseTo(1, 3);
  });
  test("in and out are symmetric", () => {
    expect(pinchRatio(100, 250, calm) * pinchRatio(250, 100, calm)).toBeCloseTo(1, 9);
  });
  test("the config keys are public, in range, and whole numbers", () => {
    for (const key of [
      "words.pinchGainPct",
      "words.pinchDeadZonePct",
      "words.pinchSmoothMs",
    ] as const) {
      const d = CONFIG[key];
      expect(d.audience).toBe("public");
      expect(Number.isInteger(d.default)).toBe(true);
      expect(d.default).toBeGreaterThanOrEqual(d.min ?? -Infinity);
      expect(d.default).toBeLessThanOrEqual(d.max ?? Infinity);
    }
  });
});

describe("row-pinch: easing", () => {
  test("moves part of the way per frame, frame-rate free", () => {
    const a = easeToward(66, 100, 16, 70);
    expect(a).toBeGreaterThan(66);
    expect(a).toBeLessThan(100);
    // Two 8 ms frames land where one 16 ms frame does.
    expect(easeToward(easeToward(66, 100, 8, 70), 100, 8, 70)).toBeCloseTo(a, 9);
  });
  test("never overshoots, and arrives", () => {
    let h = 66;
    for (let i = 0; i < 200; i++) {
      h = easeToward(h, 100, 16, 70);
      expect(h).toBeLessThanOrEqual(100);
    }
    expect(h).toBe(100);
  });
  test("0 ms: straight to the fingers", () => {
    expect(easeToward(66, 100, 16, 0)).toBe(100);
  });
});

describe("row-pinch: the anchor row stays under the fingers", () => {
  test("where on the row the fingers are", () => {
    expect(anchorFrac(150, 100, 100)).toBe(0.5);
    expect(anchorFrac(50, 100, 100)).toBe(0);
    expect(anchorFrac(250, 100, 100)).toBe(1);
  });
  /** A list of fixed rows: row i's top on screen for a scroll and a height. */
  const screenTop = (i: number, scroll: number, h: number, pad = 300) => pad + i * h - scroll;
  test("every height keeps the anchor point at the fingers", () => {
    const i = 40;
    let scroll = 2400;
    let h = 66;
    const midY = screenTop(i, scroll, h) + 20;
    const frac = anchorFrac(midY, screenTop(i, scroll, h), h);
    const want = screenTop(i, scroll, h) + frac * h;
    for (const next of [70, 81.3, 99.9, 140, 120, 55, 30, 66]) {
      h = next;
      scroll = anchoredScroll(scroll, screenTop(i, scroll, h), h, frac, midY);
      expect(Math.abs(screenTop(i, scroll, h) + frac * h - want)).toBeLessThan(1e-9);
    }
  });
  test("the fingers drift: the row follows them", () => {
    const h = 66;
    const scroll = anchoredScroll(1000, screenTop(10, 1000, h), h, 0.5, 300);
    expect(screenTop(10, scroll, h) + 0.5 * h).toBeCloseTo(300, 9);
  });
  test("never a negative scroll", () => {
    expect(anchoredScroll(0, 10, 66, 0, 500)).toBe(0);
  });
});
