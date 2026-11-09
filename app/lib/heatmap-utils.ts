import type { HeatmapData, TallyStrokes } from "@/types/heatmap";

/** The strokes of 正, in writing order, on a 10×10 box (ActivityHeatmap). */
export const TALLY_STROKES = [
  "M1.6 1.6H8.4", // 一 the top
  "M5 1.6V8.4", // 丨 the middle, down
  "M5 5H8", // 一 the short one, right
  "M2.4 5.2V8.4", // 丨 the short one, left
  "M1 8.4H9", // 一 the base
] as const;

/**
 * How many strokes of 正 each active day gets: 1–5 by the day's place among
 * the learner's own active days (its mid-rank quantile), so the marks follow
 * their pace and no number of reviews is built in. Days without reviews get
 * no entry and no mark. Equal days get equal strokes; a learner whose days are
 * all alike sees 3 strokes on each.
 */
export function tallyStrokes(data: HeatmapData): Record<string, TallyStrokes> {
  const active = Object.entries(data).filter(([, n]) => n > 0);
  const counts = active.map(([, n]) => n).sort((a, b) => a - b);
  const total = counts.length;
  // First index whose count is > n (strict) or >= n (!strict).
  const bound = (n: number, strict: boolean) => {
    let lo = 0;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (strict ? counts[mid] <= n : counts[mid] < n) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const out: Record<string, TallyStrokes> = {};
  for (const [date, n] of active) {
    const lo = bound(n, false);
    const p = (lo + (bound(n, true) - lo) / 2) / total;
    out[date] = Math.min(5, Math.max(1, Math.ceil(p * 5))) as TallyStrokes;
  }
  return out;
}

/** "Nov 10, 2026"-style date in the reader's locale (lib/dates.ts' unambiguous style). */
export function formatDate(dateStr: string, locale = "en"): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

export function getMonthLabel(weekIndex: number, startDate: Date, locale = "en"): string | null {
  const weekDate = new Date(startDate);
  weekDate.setDate(weekDate.getDate() + weekIndex * 7);

  const prevWeekDate = new Date(startDate);
  prevWeekDate.setDate(prevWeekDate.getDate() + (weekIndex - 1) * 7);

  if (weekIndex === 0 || weekDate.getMonth() !== prevWeekDate.getMonth()) {
    return weekDate.toLocaleDateString(locale, { month: "short" });
  }

  return null;
}
