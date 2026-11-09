"use client";

import { useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { barText, chartModel, type MonthBar } from "@/lib/signups-chart";

const BAR = "fill-[oklch(0.5_0.132_22.3)] dark:fill-[oklch(0.74_0.121_22.3)]";
const LINE = "stroke-[oklch(0.5_0.132_22.3)] dark:stroke-[oklch(0.74_0.121_22.3)]";

/**
 * New accounts per JST calendar month. Finished months are solid bars; the
 * current one is solid up to today plus a hatched part up to its forecast.
 * Hover, tap or focus a bar to read it; the newest month is shown first.
 */
export default function SignupsChart({ series }: { series: MonthBar[] }) {
  const c = useIntlayer("dev-users");
  const m = chartModel(series);
  const [sel, setSel] = useState(series.length - 1);
  const box = useRef<HTMLDivElement>(null);
  // Start scrolled to the newest month when the chart is wider than the screen.
  useEffect(() => {
    if (box.current) box.current.scrollLeft = box.current.scrollWidth;
  }, []);
  const strings = { barDone: c.barDone.value, barCurrent: c.barCurrent.value };
  const swatch = "inline-block h-3 w-3 align-[-1px] mr-1 rounded-[2px]";

  return (
    <section className="space-y-2" data-signups-chart>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-medium">{c.signupsTitle.value}</h2>
        <div className="flex gap-3 text-xs">
          <span>
            <span
              className={`${swatch} bg-[oklch(0.5_0.132_22.3)] dark:bg-[oklch(0.74_0.121_22.3)]`}
            />
            {c.signupsLegend.value}
          </span>
          <span>
            <svg className={swatch} viewBox="0 0 12 12" aria-hidden>
              <rect
                x="0.5"
                y="0.5"
                width="11"
                height="11"
                fill="url(#signups-hatch)"
                strokeDasharray="2 1.5"
                className={LINE}
              />
            </svg>
            {c.forecastLegend.value}
          </span>
        </div>
      </div>
      <p className="text-sm tabular-nums min-h-5" aria-live="polite" data-readout>
        {series[sel] && barText(series[sel], strings)}
      </p>
      <div className="flex">
        {/* The axis numbers stay put while the bars scroll sideways on a phone. */}
        <svg width={30} height={m.height} aria-hidden className="shrink-0 text-[11px] tabular-nums">
          {m.ticks.map((t) => (
            <text
              key={t.v}
              x={26}
              y={t.y + 4}
              textAnchor="end"
              fill="currentColor"
              fillOpacity={0.75}
            >
              {t.v}
            </text>
          ))}
        </svg>
        <div ref={box} className="overflow-x-auto min-w-0">
          <svg
            width={m.width}
            height={m.height}
            viewBox={`0 0 ${m.width} ${m.height}`}
            role="group"
            aria-label={c.signupsTitle.value}
            className="block text-[11px] tabular-nums"
          >
            <defs>
              <pattern
                id="signups-hatch"
                width="5"
                height="5"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line x1="0" y1="0" x2="0" y2="5" strokeWidth="2" className={LINE} />
              </pattern>
            </defs>
            {m.ticks.map((t) => (
              <line
                key={t.v}
                x1={0}
                x2={m.width}
                y1={t.y}
                y2={t.y}
                stroke="currentColor"
                strokeOpacity={t.v ? 0.12 : 0.35}
              />
            ))}
            {m.bars.map((b, i) => (
              <g
                key={b.month}
                tabIndex={0}
                role="button"
                aria-label={barText(b, strings)}
                aria-pressed={i === sel}
                data-month={b.month}
                onPointerEnter={() => setSel(i)}
                onFocus={() => setSel(i)}
                onClick={() => setSel(i)}
                className="outline-none cursor-default"
              >
                <rect x={b.x - 5} y={0} width={28} height={m.height} fill="transparent" />
                {b.fh !== undefined && (
                  <rect
                    x={b.x + 0.5}
                    y={b.fy}
                    width={17}
                    height={b.fh}
                    fill="url(#signups-hatch)"
                    strokeDasharray="3 2"
                    className={LINE}
                    data-forecast={b.forecast}
                  />
                )}
                <rect
                  x={b.x}
                  y={b.y}
                  width={18}
                  height={b.h}
                  className={BAR}
                  stroke={i === sel ? "currentColor" : "none"}
                  strokeWidth={1.5}
                />
                <text
                  x={b.x + 9}
                  y={m.base + 13}
                  textAnchor="middle"
                  fill="currentColor"
                  fillOpacity={i === sel ? 1 : 0.75}
                  fontWeight={i === sel ? 600 : 400}
                >
                  {b.label}
                </text>
                {b.year && (
                  <text
                    x={b.x + 9}
                    y={m.base + 27}
                    textAnchor="middle"
                    fill="currentColor"
                    fillOpacity={0.75}
                  >
                    {b.year}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
      </div>
      <p className="text-xs opacity-70">{c.forecastHow.value}</p>
    </section>
  );
}
