"use client";

import { formatDate } from "@/app/lib/heatmap-utils";
import type { HeatmapTooltipProps } from "@/types/heatmap";

export default function HeatmapTooltip({ date, count, isVisible, position }: HeatmapTooltipProps) {
  if (!isVisible) return null;

  return (
    <div
      className="fixed z-50 px-3 py-2 text-sm bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md shadow-lg pointer-events-none"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transform: "translate(-50%, -100%) translateY(-8px)",
      }}
    >
      <div className="font-medium">
        {count === 0 ? "No reviews" : count === 1 ? "1 review" : `${count} reviews`}
      </div>
      <div className="text-xs opacity-75">{formatDate(date)}</div>
    </div>
  );
}
