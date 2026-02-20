import type { ColorIntensity, HeatmapData, StreakData } from "@/types/heatmap";

export const HEATMAP_COLORS = {
  light: {
    0: "#ebedf0",
    1: "#9be9a8",
    2: "#40c463",
    3: "#30a14e",
    4: "#216e39",
  },
  dark: {
    0: "#161b22",
    1: "#0e4429",
    2: "#006d32",
    3: "#26a641",
    4: "#39d353",
  },
};

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

export function generateDateRange(startDate: Date, endDate: Date): string[] {
  const dates: string[] = [];
  const current = new Date(startDate);

  while (current <= endDate) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

export function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day;
  return new Date(d.setDate(diff));
}

function isConsecutiveDay(date1: string, date2: string): boolean {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays === 1;
}

export function calculateStreaks(data: HeatmapData): StreakData {
  const sortedDates = Object.keys(data)
    .filter((date) => data[date] > 0)
    .sort();

  if (sortedDates.length === 0) {
    return { current: 0, longest: 0 };
  }

  let current = 0;
  let longest = 0;
  let temp = 0;

  const today = new Date().toISOString().split("T")[0];

  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i];
    const prevDate = sortedDates[i - 1];

    if (i === 0 || isConsecutiveDay(prevDate, date)) {
      temp++;
    } else {
      temp = 1;
    }

    longest = Math.max(longest, temp);

    if (date === today || isConsecutiveDay(date, today)) {
      current = temp;
    }
  }

  return { current, longest };
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
