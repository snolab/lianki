export type HeatmapData = Record<string, number>;

export interface StreakData {
  current: number;
  longest: number;
}

export interface HeatmapResponse {
  data: HeatmapData;
  totalReviews: number;
  streak: StreakData;
}

export type ColorIntensity = 0 | 1 | 2 | 3 | 4;

export interface ActivityHeatmapProps {
  data: HeatmapData;
  startDate: Date;
  endDate: Date;
}

export interface HeatmapTooltipProps {
  date: string;
  count: number;
  isVisible: boolean;
  position: { x: number; y: number };
}
