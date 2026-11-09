import type { ColorIntensity } from "@/types/heatmap";

export const INTENSITY_CLASSES = {
  0: "bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800",
  1: "bg-green-200 dark:bg-green-900/50",
  2: "bg-green-400 dark:bg-green-700",
  3: "bg-green-600 dark:bg-green-500",
  4: "bg-green-800 dark:bg-green-300",
};

export function getColorIntensity(count: number): ColorIntensity {
  if (count === 0) return 0;
  if (count <= 3) return 1;
  if (count <= 6) return 2;
  if (count <= 9) return 3;
  return 4;
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function getMonthLabel(weekIndex: number, startDate: Date): string | null {
  const weekDate = new Date(startDate);
  weekDate.setDate(weekDate.getDate() + weekIndex * 7);

  const prevWeekDate = new Date(startDate);
  prevWeekDate.setDate(prevWeekDate.getDate() + (weekIndex - 1) * 7);

  if (weekIndex === 0 || weekDate.getMonth() !== prevWeekDate.getMonth()) {
    return weekDate.toLocaleDateString("en-US", { month: "short" });
  }

  return null;
}
