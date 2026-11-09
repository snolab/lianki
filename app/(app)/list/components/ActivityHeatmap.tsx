"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import type { ActivityHeatmapProps, TallyStrokes } from "@/types/heatmap";
import { formatDate, getMonthLabel, TALLY_STROKES, tallyStrokes } from "@/app/lib/heatmap-utils";
import HeatmapTooltip from "./HeatmapTooltip";

const CELL_SIZE = 14;
const CELL_GAP = 2;

/** A drawn 正 with its first `n` strokes, in seal red (currentColor). */
function Tally({ n, size = CELL_SIZE }: { n: TallyStrokes; size?: number }) {
  return (
    <svg
      viewBox="0 0 10 10"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
    >
      {TALLY_STROKES.slice(0, n).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * "My learning activity" on /list: a year of days, and on each day with
 * reviews a 正 tally of 1–5 strokes by that day's place among the learner's
 * own days (tallyStrokes). Empty days get no mark. The glyph is the same in
 * every locale; each marked day carries its count as an accessible label.
 */
export default function ActivityHeatmap({ data, startDate, endDate }: ActivityHeatmapProps) {
  const s = useIntlayer("activity-tally");
  const { locale } = useLocale();
  const [tooltip, setTooltip] = useState<{ label: string; x: number; y: number } | null>(null);
  const strokes = useMemo(() => tallyStrokes(data), [data]);
  // Open at the latest weeks: on a phone the year is wider than the screen.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  const plural = useMemo(() => new Intl.PluralRules(locale), [locale]);
  const dayLabel = (date: string, count: number) =>
    (plural.select(count) === "one" && count === 1 ? s.dayOne.value : s.dayOther.value)
      .replace("{date}", formatDate(date, locale))
      .replace("{count}", count.toLocaleString(locale));
  // Weekday names in the reader's locale (Mon, Wed, Fri rows), from a known Sunday.
  const weekdays = useMemo(
    () =>
      [1, 3, 5].map((d) =>
        new Date(Date.UTC(2023, 0, 1 + d)).toLocaleDateString(locale, {
          weekday: "short",
          timeZone: "UTC",
        }),
      ),
    [locale],
  );

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

  const show = (event: React.SyntheticEvent<HTMLElement>, label: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({ label, x: rect.left + rect.width / 2, y: rect.top });
  };
  const hide = () => setTooltip(null);
  const cell = { width: `${CELL_SIZE}px`, height: `${CELL_SIZE}px` };

  return (
    <div className="relative" data-activity-tally>
      <div className="overflow-x-auto" ref={scroller}>
        <div className="inline-flex flex-col gap-1">
          <div className="flex ms-10" style={{ gap: `${CELL_GAP}px` }} aria-hidden="true">
            {weeks.map((_, weekIndex) => (
              <div
                key={weekIndex}
                className="text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap"
                style={{ width: `${CELL_SIZE}px` }}
              >
                {getMonthLabel(weekIndex, new Date(startDate), locale)}
              </div>
            ))}
          </div>

          <div className="flex gap-1">
            <div
              className="flex flex-col justify-around w-9 shrink-0 text-xs text-gray-600 dark:text-gray-400 pe-1"
              aria-hidden="true"
            >
              {weekdays.map((day) => (
                <div key={day} className="truncate" style={{ lineHeight: `${CELL_SIZE}px` }}>
                  {day}
                </div>
              ))}
            </div>

            <div
              role="list"
              aria-label={s.figure.value}
              className="flex text-blue-600 dark:text-blue-400"
              style={{ gap: `${CELL_GAP}px` }}
            >
              {weeks.map((week, weekIndex) => (
                <div key={weekIndex} className="flex flex-col" style={{ gap: `${CELL_GAP}px` }}>
                  {week.map((date, dayIndex) => {
                    const n = date ? strokes[date] : undefined;
                    if (!date || !n) {
                      return <div key={date || dayIndex} style={cell} aria-hidden="true" />;
                    }
                    const label = dayLabel(date, data[date]);
                    return (
                      <div
                        key={date}
                        role="listitem"
                        aria-label={label}
                        tabIndex={0}
                        data-strokes={n}
                        className="rounded-sm cursor-default hover:ring-2 hover:ring-blue-400 focus-visible:ring-2 focus-visible:ring-blue-400 outline-none"
                        style={cell}
                        onMouseEnter={(e) => show(e, label)}
                        onMouseLeave={hide}
                        onFocus={(e) => show(e, label)}
                        onBlur={hide}
                      >
                        <Tally n={n} />
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {tooltip && <HeatmapTooltip label={tooltip.label} position={tooltip} />}

      <div
        className="mt-4 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400"
        role="note"
        aria-label={s.legend.value}
      >
        <span aria-hidden="true">{s.less.value}</span>
        <div className="flex gap-1 text-blue-600 dark:text-blue-400" aria-hidden="true">
          {([1, 2, 3, 4, 5] as const).map((n) => (
            <Tally key={n} n={n} />
          ))}
        </div>
        <span aria-hidden="true">{s.more.value}</span>
      </div>
    </div>
  );
}
