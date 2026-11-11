"use client";

/**
 * A bucket × feature table for /dev/costs (docs/payments.md, "Cost ledger"):
 * one row per JST day or hour (a VirtualList, every bucket of the window),
 * one column per feature, the row sum on the right and the column sums on
 * top. Each cell shows its free cost over its paid cost on a seal-red heat
 * ground (heat.ts: AA text on every level, light and dark); the number is
 * always there, so the colour is never alone.
 */
import type { CSSProperties, ReactNode } from "react";
import { VirtualList } from "@/app/components/VirtualList";
import { heatLevel, heatVars, HEAT_LEVELS } from "./heat";

export type Totals = {
  freeMicro: number;
  freeCalls: number;
  paidMicro: number;
  paidCredits: number;
  paidCalls: number;
};
export type Matrix = {
  rows: { bucket: string; total: Totals; cells: Record<string, Totals> }[];
  features: ({ feature: string } & Totals)[];
  totals: Totals;
};

const LINE = "border-[oklch(0.88_0_0)] dark:border-[oklch(0.35_0_0)]";
const cost = (t: Totals | undefined) => (t ? t.freeMicro + t.paidMicro : 0);

/** The heat ground: light/dark values from heat.ts through custom properties. */
export const HEAT_CSS = `.lk-heat{background:var(--heat-l);color:var(--heat-lt)}
@media (prefers-color-scheme: dark){.lk-heat{background:var(--heat-d);color:var(--heat-dt)}}`;

export function HeatLegend({ less, more }: { less: ReactNode; more: ReactNode }) {
  return (
    <div className="flex items-center gap-1 text-xs" aria-hidden="true">
      <span className="opacity-80">{less}</span>
      {HEAT_LEVELS.slice(1).map((_, i) => (
        <span
          key={i}
          className={`lk-heat inline-block w-5 h-4 rounded-sm border ${LINE}`}
          style={heatVars(i + 1) as CSSProperties}
        />
      ))}
      <span className="opacity-80">{more}</span>
    </div>
  );
}

export function CostMatrix({
  matrix,
  label,
  totalLabel,
  usd,
  testId,
  name,
  describe,
}: {
  matrix: Matrix;
  /** How a bucket reads in its row head. */
  label: (bucket: string) => string;
  totalLabel: ReactNode;
  usd: (micro: number) => string;
  testId: string;
  name: string;
  /** A cell's full reading for screen readers and the hover title. */
  describe: (bucket: string, feature: string, t: Totals | undefined) => string;
}) {
  const feats = matrix.features.map((f) => f.feature);
  let max = 0;
  for (const r of matrix.rows) for (const f of feats) max = Math.max(max, cost(r.cells[f]));
  const cols = `minmax(6.5rem,1fr) repeat(${feats.length + 1}, minmax(6rem,1fr))`;
  const width = `${6.5 + (feats.length + 1) * 6}rem`;

  const cell = (t: Totals | undefined, title: string, lv: number, key: string) => (
    <span
      key={key}
      title={title}
      aria-label={title}
      className="lk-heat rounded-sm px-1 py-0.5 text-right tabular-nums text-[0.7rem] leading-tight"
      style={heatVars(lv) as CSSProperties}
    >
      <span className="block">{usd(t?.freeMicro ?? 0)}</span>
      <span className="block opacity-90">{usd(t?.paidMicro ?? 0)}</span>
    </span>
  );

  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <div style={{ minWidth: width }}>
        <div
          className={`grid gap-1 text-xs py-1 border-b ${LINE} items-end`}
          style={{ gridTemplateColumns: cols }}
          role="presentation"
        >
          <span />
          {matrix.features.map((f) => (
            <span key={f.feature} className="text-right">
              <span className="block font-mono break-all">{f.feature}</span>
              <span className="block tabular-nums font-semibold">{usd(cost(f))}</span>
            </span>
          ))}
          <span className="text-right">
            <span className="block">{totalLabel}</span>
            <span className="block tabular-nums font-semibold text-[var(--brand)]">
              {usd(cost(matrix.totals))}
            </span>
          </span>
        </div>
        <VirtualList
          items={matrix.rows}
          getKey={(r) => r.bucket}
          name={name}
          hasMore={false}
          loading={false}
          onReachEnd={() => {}}
          total={matrix.rows.length}
          estimateSize={40}
          renderItem={(r) => (
            <div
              className={`grid gap-1 py-0.5 border-b ${LINE} items-center`}
              style={{ gridTemplateColumns: cols }}
              data-testid={`${testId}-row`}
            >
              <span className="font-mono text-xs">{label(r.bucket)}</span>
              {feats.map((f) =>
                cell(
                  r.cells[f],
                  describe(r.bucket, f, r.cells[f]),
                  heatLevel(cost(r.cells[f]), max),
                  f,
                ),
              )}
              <span className="text-right tabular-nums text-xs font-semibold">
                <span className="block">{usd(r.total.freeMicro)}</span>
                <span className="block">{usd(r.total.paidMicro)}</span>
              </span>
            </div>
          )}
        />
      </div>
    </div>
  );
}
