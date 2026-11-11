export type HeatmapData = Record<string, number>;

/** Strokes of 正 drawn for a day with reviews (app/lib/heatmap-utils.ts). */
export type TallyStrokes = 1 | 2 | 3 | 4 | 5;

export interface ActivityHeatmapProps {
  data: HeatmapData;
  startDate: Date;
  endDate: Date;
}

export interface HeatmapTooltipProps {
  label: string;
  position: { x: number; y: number };
}
