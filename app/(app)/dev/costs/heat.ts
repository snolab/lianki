/**
 * The colours of /dev/costs (docs/payments.md, "Cost ledger"): the seal-red
 * heat scale of the matrices and the red/gold series of the charts. All
 * oklch; every heat level's text is AA on its cell in light and dark
 * (unit/cost-buckets.test.ts). Colour is never alone: a heat cell shows its
 * number, a chart series has its own pattern and a direct label.
 */

export type HeatLevel = { light: string; lightText: string; dark: string; darkText: string };

const INK = "oklch(0.22 0.015 65)";
const PAPER = "oklch(0.985 0.01 85)";
const INK_BG = "oklch(0.18 0.01 65)";
const PAPER_FG = "oklch(0.92 0.02 82)";

/** Level 0 = nothing (no fill); 1–5 = deeper seal red. */
export const HEAT_LEVELS: HeatLevel[] = [
  { light: "transparent", lightText: INK, dark: "transparent", darkText: PAPER_FG },
  { light: "oklch(0.93 0.04 30)", lightText: INK, dark: "oklch(0.27 0.05 22)", darkText: PAPER_FG },
  { light: "oklch(0.87 0.07 28)", lightText: INK, dark: "oklch(0.34 0.09 22)", darkText: PAPER_FG },
  { light: "oklch(0.79 0.11 25)", lightText: INK, dark: "oklch(0.42 0.13 22)", darkText: PAPER_FG },
  {
    light: "oklch(0.53 0.207 22.3)",
    lightText: PAPER,
    dark: "oklch(0.62 0.2 20)",
    darkText: INK_BG,
  },
  { light: "oklch(0.42 0.17 22)", lightText: PAPER, dark: "oklch(0.74 0.15 22)", darkText: INK_BG },
];

/** The level of `v` against the view's largest cell: square-root scale, so small costs still show. */
export function heatLevel(v: number, max: number): number {
  if (!(v > 0) || !(max > 0)) return 0;
  const top = HEAT_LEVELS.length - 1;
  return Math.max(1, Math.min(top, Math.ceil(Math.sqrt(v / max) * top)));
}

/** The CSS custom properties a heat cell reads (see `.lk-heat` in CostMatrix.tsx). */
export const heatVars = (level: number) => {
  const h = HEAT_LEVELS[level] ?? HEAT_LEVELS[0];
  return {
    "--heat-l": h.light,
    "--heat-lt": h.lightText,
    "--heat-d": h.dark,
    "--heat-dt": h.darkText,
  } as Record<string, string>;
};

/** Chart series: seal red and gold, alternating dark and light, each with a pattern. */
export const SERIES = [
  { fill: "oklch(0.53 0.207 22.3)", pattern: "solid" },
  { fill: "oklch(0.75 0.14 80)", pattern: "diagonal" },
  { fill: "oklch(0.38 0.15 22)", pattern: "dots" },
  { fill: "oklch(0.89 0.12 86)", pattern: "cross" },
  { fill: "oklch(0.5 0.1 70)", pattern: "horizontal" },
  { fill: "oklch(0.72 0.12 20)", pattern: "vertical" },
] as const;
/** How many features a chart shows by name; the rest are one "other" series. */
export const CHART_MAX_SERIES = SERIES.length - 1;
