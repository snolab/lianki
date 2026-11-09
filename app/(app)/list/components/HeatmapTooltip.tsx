"use client";

import type { HeatmapTooltipProps } from "@/types/heatmap";

/** The day's label over a tally on hover or focus (ActivityHeatmap). */
export default function HeatmapTooltip({ label, position }: HeatmapTooltipProps) {
  return (
    <div
      aria-hidden="true"
      className="fixed z-50 px-3 py-2 text-sm font-medium bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md shadow-lg pointer-events-none"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transform: "translate(-50%, -100%) translateY(-8px)",
      }}
    >
      {label}
    </div>
  );
}
