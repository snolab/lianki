"use client";

import { useState } from "react";
import type { ActivityHeatmapProps } from "@/types/heatmap";
import { getColorIntensity, getMonthLabel, INTENSITY_CLASSES } from "@/app/lib/heatmap-utils";
import HeatmapTooltip from "./HeatmapTooltip";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CELL_SIZE = 12;
const CELL_GAP = 3;

export default function ActivityHeatmap({ data, startDate, endDate }: ActivityHeatmapProps) {
  const [tooltip, setTooltip] = useState<{
    date: string;
    count: number;
    x: number;
    y: number;
  } | null>(null);

  const weeks: string[][] = [];
  const current = new Date(startDate);
  const end = new Date(endDate);

  const weekStart = new Date(current);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());

  while (weekStart <= end) {
    const week: string[] = [];
    for (let day = 0; day < 7; day++) {
      const date = new Date(weekStart);
      date.setDate(date.getDate() + day);

      if (date >= current && date <= end) {
        week.push(date.toISOString().split("T")[0]);
      } else {
        week.push("");
      }
    }
    weeks.push(week);
    weekStart.setDate(weekStart.getDate() + 7);
  }

  const handleCellHover = (
    event: React.MouseEvent<HTMLDivElement>,
    date: string,
    count: number,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({
      date,
      count,
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  };

  const handleCellLeave = () => {
    setTooltip(null);
  };

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <div className="inline-flex flex-col gap-1">
          <div className="flex gap-1 ml-8">
            {weeks.map((_, weekIndex) => {
              const monthLabel = getMonthLabel(weekIndex, new Date(startDate));
              return (
                <div
                  key={weekIndex}
                  className="text-xs text-gray-600 dark:text-gray-400"
                  style={{ width: `${CELL_SIZE}px` }}
                >
                  {monthLabel}
                </div>
              );
            })}
          </div>

          <div className="flex gap-1">
            <div className="flex flex-col justify-between text-xs text-gray-600 dark:text-gray-400 pr-2">
              {DAYS.filter((_, i) => i % 2 === 1).map((day) => (
                <div key={day} style={{ height: `${CELL_SIZE}px`, lineHeight: `${CELL_SIZE}px` }}>
                  {day}
                </div>
              ))}
            </div>

            <div className="flex" style={{ gap: `${CELL_GAP}px` }}>
              {weeks.map((week, weekIndex) => (
                <div key={weekIndex} className="flex flex-col" style={{ gap: `${CELL_GAP}px` }}>
                  {week.map((date, dayIndex) => {
                    if (!date) {
                      return (
                        <div
                          key={dayIndex}
                          style={{ width: `${CELL_SIZE}px`, height: `${CELL_SIZE}px` }}
                        />
                      );
                    }

                    const count = data[date] || 0;
                    const intensity = getColorIntensity(count);

                    return (
                      <div
                        key={date}
                        className={`rounded-sm cursor-pointer transition-all hover:ring-2 hover:ring-blue-400 ${INTENSITY_CLASSES[intensity]}`}
                        style={{ width: `${CELL_SIZE}px`, height: `${CELL_SIZE}px` }}
                        onMouseEnter={(e) => handleCellHover(e, date, count)}
                        onMouseLeave={handleCellLeave}
                        title={`${count} reviews on ${date}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {tooltip && (
        <HeatmapTooltip
          date={tooltip.date}
          count={tooltip.count}
          isVisible={true}
          position={{ x: tooltip.x, y: tooltip.y }}
        />
      )}

      <div className="mt-4 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        <span>Less</span>
        <div className="flex gap-1">
          {[0, 1, 2, 3, 4].map((level) => (
            <div
              key={level}
              className={`rounded-sm ${INTENSITY_CLASSES[level as 0 | 1 | 2 | 3 | 4]}`}
              style={{ width: `${CELL_SIZE}px`, height: `${CELL_SIZE}px` }}
            />
          ))}
        </div>
        <span>More</span>
      </div>
    </div>
  );
}
