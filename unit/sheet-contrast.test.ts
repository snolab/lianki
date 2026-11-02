import { describe, expect, it } from "bun:test";
import {
  SHEET_SCRIM,
  SHEET_SOLID_ALPHA,
  oklchToSrgb,
  sheetScrim,
  srgbLuminance,
  textOnScrim,
} from "@lianki/debug-chat/log-surface";

// The page (app/globals.css) and the log's text (Tailwind gray in oklch).
const PAGE = {
  light: { paper: { l: 0.945, c: 0.02, h: 82 }, ink: { l: 0.22, c: 0.015, h: 65 } },
  dark: { paper: { l: 0.18, c: 0.01, h: 65 }, ink: { l: 0.92, c: 0.02, h: 82 } },
};
const TEXT = {
  light: { l: 0.278, c: 0.033, h: 256.8 }, // gray-800, the log's lines
  dark: { l: 0.967, c: 0.003, h: 264.5 }, // gray-100
};
const mix = (a: [number, number, number], b: [number, number, number], t: number) =>
  a.map((v, i) => (1 - t) * v + t * b[i]!) as [number, number, number];

describe("the full-screen log's glass: WCAG AA over a busy page", () => {
  for (const scheme of ["light", "dark"] as const) {
    const paper = oklchToSrgb(PAGE[scheme].paper);
    const ink = oklchToSrgb(PAGE[scheme].ink);
    const scrim = SHEET_SCRIM[scheme];

    it(`${scheme}: blurred, a dense list behind (40% ink) — 4.5:1 or more`, () => {
      // A 20px blur averages a list's text into a wash; 40% ink is denser than any list.
      const behind = mix(paper, ink, 0.4);
      expect(textOnScrim(TEXT[scheme], scrim, scrim.a, behind)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${scheme}: nothing blurs (fallback), right over the list's ink — 4.5:1 or more`, () => {
      expect(textOnScrim(TEXT[scheme], scrim, SHEET_SOLID_ALPHA, ink)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${scheme}: the page's own text shows through fainter than with the old 60% sheet`, () => {
      // What made it hard to read (the owner's Android screenshot) was the list's
      // glyphs showing through under the log's: the residual contrast of the
      // page's ink against its paper, seen through the sheet (before any blur).
      const through = (s: { l: number; c: number; h: number }, a: number) => {
        const c = oklchToSrgb(s);
        const y = (b: [number, number, number]) =>
          srgbLuminance(c.map((v, i) => a * v + (1 - a) * b[i]!) as [number, number, number]);
        const [y1, y2] = [y(paper), y(ink)];
        return (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05);
      };
      const now = through(scrim, scrim.a);
      const old = through(PAGE[scheme].paper, 0.6);
      console.log(
        `${scheme}: page text through the sheet ${now.toFixed(2)}:1 (old ${old.toFixed(2)}:1)`,
      );
      expect(now).toBeLessThan(old);
    });
  }

  it("sheetScrim: both schemes in one light-dark() value, near-opaque when solid", () => {
    expect(sheetScrim(false)).toBe(
      "light-dark(oklch(98% 0.01 90 / 0.72), oklch(18% 0.01 260 / 0.66))",
    );
    expect(sheetScrim(true)).toBe(
      "light-dark(oklch(98% 0.01 90 / 0.92), oklch(18% 0.01 260 / 0.92))",
    );
  });

  it("srgbLuminance: black 0, white 1", () => {
    expect(srgbLuminance([0, 0, 0])).toBe(0);
    expect(srgbLuminance([1, 1, 1])).toBeCloseTo(1, 5);
    expect(srgbLuminance(oklchToSrgb({ l: 0, c: 0, h: 0 }))).toBe(0);
  });
});
