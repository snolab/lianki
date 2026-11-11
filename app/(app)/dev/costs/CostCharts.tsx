"use client";

/**
 * The charts of /dev/costs (docs/payments.md, "Cost ledger"): cost over time
 * (per JST day, per JST hour) stacked by service or by free/paid, and the top
 * accounts. Inline SVG, no chart library. Red/gold series (heat.ts), each with
 * its own pattern and a direct label in the legend, so colour is never alone.
 * Hover, tap or the arrow keys show a bar's exact values; the same numbers are
 * in the tables below (aria-describedby).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CHART_MAX_SERIES, SERIES } from "./heat";
import type { Matrix, Totals } from "./CostMatrix";

export type Series = { key: string; label: string; values: number[] };
type Pattern = (typeof SERIES)[number]["pattern"];

const cost = (t: Totals | undefined) => (t ? t.freeMicro + t.paidMicro : 0);

/** Top features by cost as series, the rest summed as one `other` series. */
export function featureSeries(m: Matrix, other: string): Series[] {
  const top = m.features.slice(0, CHART_MAX_SERIES).map((f) => f.feature);
  const rest = m.features.slice(CHART_MAX_SERIES).map((f) => f.feature);
  const out: Series[] = top.map((f) => ({
    key: f,
    label: f,
    values: m.rows.map((r) => cost(r.cells[f])),
  }));
  if (rest.length)
    out.push({
      key: "-other",
      label: other,
      values: m.rows.map((r) => rest.reduce((s, f) => s + cost(r.cells[f]), 0)),
    });
  return out;
}

/** Free and paid as two series. */
export const freePaidSeries = (m: Matrix, free: string, paid: string): Series[] => [
  { key: "-paid", label: paid, values: m.rows.map((r) => r.total.paidMicro) },
  { key: "-free", label: free, values: m.rows.map((r) => r.total.freeMicro) },
];

function PatternDef({ id, kind }: { id: string; kind: Pattern }) {
  if (kind === "solid") return null;
  const s = { stroke: "var(--background)", strokeWidth: 1.5 };
  return (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse">
      {kind === "diagonal" ? <path d="M-1,7 L7,-1" {...s} /> : null}
      {kind === "horizontal" ? <path d="M0,3 H6" {...s} /> : null}
      {kind === "vertical" ? <path d="M3,0 V6" {...s} /> : null}
      {kind === "cross" ? <path d="M0,3 H6 M3,0 V6" {...s} /> : null}
      {kind === "dots" ? <circle cx="3" cy="3" r="1.3" fill="var(--background)" /> : null}
    </pattern>
  );
}

function Swatch({ i, pid }: { i: number; pid: string }) {
  const s = SERIES[i % SERIES.length];
  return (
    <svg width="18" height="12" aria-hidden="true" className="shrink-0">
      <rect width="18" height="12" rx="2" fill={s.fill} />
      {s.pattern !== "solid" ? <rect width="18" height="12" fill={`url(#${pid}-${i})`} /> : null}
    </svg>
  );
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function StackedBars({
  title,
  buckets,
  series,
  bucketLabel,
  tick,
  usd,
  totalLabel,
  hint,
  describedBy,
  testId,
}: {
  title: string;
  buckets: string[];
  series: Series[];
  /** The full reading of a bucket (tooltip). */
  bucketLabel: (b: string) => string;
  /** The short axis label of a bucket (spaced by the chart's width). */
  tick: (b: string) => string;
  usd: (micro: number) => string;
  totalLabel: string;
  hint: string;
  /** The id of the table holding the same numbers. */
  describedBy: string;
  testId: string;
}) {
  const pid = useId().replace(/:/g, "");
  const [ref, W] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const n = buckets.length;
  const totals = useMemo(
    () => buckets.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0)),
    [buckets, series],
  );
  const max = Math.max(...totals, 0);
  const H = 180;
  const left = 64;
  const bottom = 22;
  const plotW = W - left - 4;
  const plotH = H - bottom - 8;
  const bw = n ? plotW / n : 0;
  const y = (v: number) => (max > 0 ? (v / max) * plotH : 0);
  const gap = bw > 6 ? 1 : 0;
  const grand = totals.reduce((s, v) => s + v, 0);

  // One axis label per ~72 px, whatever the number of bars.
  const tickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 72))));
  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1;
      setActive((a) => Math.min(n - 1, Math.max(0, (a ?? (d > 0 ? -1 : n)) + d)));
    } else if (e.key === "Escape") setActive(null);
  };

  return (
    <figure className="space-y-2" data-testid={testId}>
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-hidden="true">
        {series.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1">
            <Swatch i={i} pid={pid} />
            <span className={s.key.startsWith("-") ? "" : "font-mono"}>{s.label}</span>
          </li>
        ))}
      </ul>
      <div ref={ref} className="relative">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          tabIndex={0}
          aria-label={`${title}: ${totalLabel} ${usd(grand)}. ${hint}`}
          aria-describedby={describedBy}
          className="block touch-pan-y focus-visible:outline-2 focus-visible:outline-[var(--brand)] rounded"
          onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
          onKeyDown={onKey}
        >
          <defs>
            {SERIES.map((s, i) => (
              <PatternDef key={i} id={`${pid}-${i}`} kind={s.pattern} />
            ))}
          </defs>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1={left}
                x2={W - 4}
                y1={8 + plotH - f * plotH}
                y2={8 + plotH - f * plotH}
                stroke="currentColor"
                strokeOpacity={0.18}
              />
              <text
                x={left - 4}
                y={8 + plotH - f * plotH + 4}
                textAnchor="end"
                fontSize="10"
                fill="currentColor"
              >
                {usd(max * f)}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            let acc = 0;
            const x = left + i * bw;
            return (
              <g key={b} opacity={active === null || active === i ? 1 : 0.55}>
                {series.map((s, k) => {
                  const v = s.values[i] ?? 0;
                  if (!(v > 0)) return null;
                  const h = Math.max(1, y(v));
                  const yy = 8 + plotH - y(acc) - h;
                  acc += v;
                  const sv = SERIES[k % SERIES.length];
                  return (
                    <g key={s.key}>
                      <rect
                        x={x + gap / 2}
                        y={yy}
                        width={Math.max(1, bw - gap)}
                        height={h}
                        fill={sv.fill}
                      />
                      {sv.pattern !== "solid" && bw >= 4 ? (
                        <rect
                          x={x + gap / 2}
                          y={yy}
                          width={Math.max(1, bw - gap)}
                          height={h}
                          fill={`url(#${pid}-${k})`}
                        />
                      ) : null}
                    </g>
                  );
                })}
                {/* The bar's hit area, full height: hover, tap or click shows its values. */}
                <rect
                  data-bar={b}
                  x={x}
                  y={8}
                  width={Math.max(1, bw)}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
                  onClick={() => setActive(i)}
                />
                {(() => {
                  const t = i % tickEvery === 0 ? tick(b) : null;
                  return t ? (
                    <text
                      x={x + bw / 2}
                      y={H - 6}
                      textAnchor="middle"
                      fontSize="10"
                      fill="currentColor"
                    >
                      {t}
                    </text>
                  ) : null;
                })()}
              </g>
            );
          })}
        </svg>
        {active !== null && buckets[active] ? (
          <div
            role="status"
            data-testid={`${testId}-tip`}
            className="absolute top-0 z-10 rounded border border-[oklch(0.8_0_0)] dark:border-[oklch(0.4_0_0)] bg-[var(--background)] px-2 py-1 text-xs shadow-md pointer-events-none max-w-[16rem]"
            style={
              left + active * bw > W / 2
                ? { right: Math.max(0, W - (left + active * bw)) }
                : { left: left + (active + 1) * bw }
            }
          >
            <div className="font-semibold">{bucketLabel(buckets[active])}</div>
            {series.map((s, k) =>
              (s.values[active] ?? 0) > 0 ? (
                <div key={s.key} className="flex items-center gap-1">
                  <Swatch i={k} pid={pid} />
                  <span className="truncate">{s.label}</span>
                  <span className="ml-auto pl-2 tabular-nums">{usd(s.values[active])}</span>
                </div>
              ) : null,
            )}
            <div className="flex font-semibold border-t mt-1 pt-1">
              <span>{totalLabel}</span>
              <span className="ml-auto pl-2 tabular-nums">{usd(totals[active])}</span>
            </div>
          </div>
        ) : null}
      </div>
      <p className="text-xs opacity-80">{hint}</p>
    </figure>
  );
}

/** The dearest accounts as stacked free/paid bars with their exact values beside. */
export function TopAccounts({
  title,
  rows,
  usd,
  free,
  paid,
}: {
  title: string;
  rows: { key: string; name: string; freeMicro: number; paidMicro: number }[];
  usd: (micro: number) => string;
  free: string;
  paid: string;
}) {
  const pid = useId().replace(/:/g, "");
  const max = Math.max(0, ...rows.map((r) => r.freeMicro + r.paidMicro));
  if (!rows.length || !(max > 0)) return null;
  // paid = series 0 (seal, solid), free = series 1 (gold, diagonal), as in freePaidSeries.
  return (
    <figure className="space-y-2" data-testid="costs-chart-accounts">
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <defs>
          <PatternDef id={`${pid}-1`} kind={SERIES[1].pattern} />
        </defs>
      </svg>
      <ul className="flex gap-3 text-xs" aria-hidden="true">
        <li className="flex items-center gap-1">
          <Swatch i={0} pid={pid} />
          {paid}
        </li>
        <li className="flex items-center gap-1">
          <Swatch i={1} pid={pid} />
          {free}
        </li>
      </ul>
      <ol className="space-y-1.5">
        {rows.map((r) => {
          const t = r.freeMicro + r.paidMicro;
          return (
            <li key={r.key} className="text-xs">
              <div className="flex gap-2">
                <span className="truncate min-w-0">{r.name}</span>
                <span className="ml-auto tabular-nums font-semibold">{usd(t)}</span>
              </div>
              <svg
                width="100%"
                height="10"
                aria-label={`${r.name}: ${paid} ${usd(r.paidMicro)}, ${free} ${usd(r.freeMicro)}`}
                role="img"
              >
                <rect
                  width={`${(r.paidMicro / max) * 100}%`}
                  height="10"
                  rx="2"
                  fill={SERIES[0].fill}
                />
                <svg
                  x={`${(r.paidMicro / max) * 100}%`}
                  width={`${(r.freeMicro / max) * 100}%`}
                  height="10"
                  overflow="visible"
                >
                  <rect width="100%" height="10" fill={SERIES[1].fill} />
                  <rect width="100%" height="10" fill={`url(#${pid}-1)`} />
                </svg>
              </svg>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
