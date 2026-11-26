"use client";

/**
 * /dev/costs, "Learning Partner tokens" (lib/payments/cost-tokens.ts; owner,
 * 2026-11-27): tiles (input, cached input, output, cache hit rate), tokens per
 * day stacked as cached input / uncached input / output, the cache hit rate
 * per day as a line, and every account with its counts, the most tokens first
 * (a VirtualList, no pages). Presentational: the data and the words come in
 * as props, so a fixture renders it as well as the page.
 */
import { VirtualList } from "@/app/components/VirtualList";
import { StackedBars, type Series } from "./CostCharts";
import { SERIES } from "./heat";

type Totals = {
  tokensIn: number;
  cachedIn: number;
  tokensOut: number;
  replies: number;
  hitRate: number | null;
};
export type TokensData = {
  range: { from: string; to: string };
  zone: string;
  bucket: "day" | "hour";
  rows: ({ bucket: string } & Totals)[];
  totals: Totals;
  users: ({ userId: string; name: string | null } & Totals)[];
};

export type TokensWords = {
  tokens: string;
  tokensNote: string;
  tokensIn: string;
  tokensCached: string;
  tokensUncached: string;
  tokensOut: string;
  tokensTotal: string;
  hitRate: string;
  replies: string;
  chartTokens: string;
  chartHitRate: string;
  tokensByUser: string;
  tokensEmpty: string;
  chartHint: string;
  guest: string;
  noName: string;
};

const LINE = "border-[oklch(0.88_0_0)] dark:border-[oklch(0.35_0_0)]";
const GRID =
  "grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,4.5rem))] sm:grid-cols-[minmax(0,1fr)_repeat(5,minmax(0,5.5rem))] gap-x-2 items-baseline";

/** Cached, uncached and output as three series (seal red, gold, deep red: SERIES 0–2). */
export const tokenBarSeries = (d: TokensData, w: TokensWords): Series[] => [
  { key: "-cached", label: w.tokensCached, values: d.rows.map((r) => r.cachedIn) },
  {
    key: "-uncached",
    label: w.tokensUncached,
    values: d.rows.map((r) => Math.max(0, r.tokensIn - r.cachedIn)),
  },
  { key: "-out", label: w.tokensOut, values: d.rows.map((r) => r.tokensOut) },
];

function HitRateLine({
  title,
  rows,
  pct,
  label,
  tick,
}: {
  title: string;
  rows: TokensData["rows"];
  pct: (r: number | null) => string;
  label: (b: string) => string;
  tick: (b: string) => string;
}) {
  // About a phone's width, so the 10 px labels stay ~10 px there.
  const W = 360;
  const H = 140;
  const left = 40;
  const bottom = 20;
  const plotW = W - left - 8;
  const plotH = H - bottom - 8;
  const n = rows.length;
  const x = (i: number) => left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (r: number) => 8 + plotH - r * plotH;
  // A day without replies has no rate: the line breaks there instead of dropping to 0.
  const segs: { i: number; r: number }[][] = [[]];
  rows.forEach((row, i) => {
    const cur = segs[segs.length - 1];
    if (row.hitRate !== null) cur.push({ i, r: row.hitRate });
    else if (cur.length) segs.push([]);
  });
  const tickEvery = Math.max(1, Math.ceil(n / 8));
  const stroke = SERIES[0].fill;
  return (
    <figure className="space-y-2" data-testid="costs-chart-hitrate">
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`${title}: ${rows.map((r) => `${label(r.bucket)} ${pct(r.hitRate)}`).join(", ")}`}
        className="block"
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={left}
              x2={W - 8}
              y1={y(f)}
              y2={y(f)}
              stroke="currentColor"
              strokeOpacity={0.18}
            />
            <text x={left - 4} y={y(f) + 4} textAnchor="end" fontSize="10" fill="currentColor">
              {pct(f)}
            </text>
          </g>
        ))}
        {segs
          .filter((s) => s.length)
          .map((s, k) => (
            <polyline
              key={k}
              points={s.map((p) => `${x(p.i)},${y(p.r)}`).join(" ")}
              fill="none"
              stroke={stroke}
              strokeWidth={2}
            />
          ))}
        {rows.map((row, i) => (
          <g key={row.bucket}>
            {row.hitRate !== null ? (
              <circle cx={x(i)} cy={y(row.hitRate)} r={3} fill={stroke}>
                <title>{`${label(row.bucket)}: ${pct(row.hitRate)}`}</title>
              </circle>
            ) : null}
            {i % tickEvery === 0 ? (
              <text x={x(i)} y={H - 4} textAnchor="middle" fontSize="10" fill="currentColor">
                {tick(row.bucket)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    </figure>
  );
}

export function PartnerTokens({
  data,
  w,
  num,
  short,
  pct,
}: {
  data: TokensData;
  w: TokensWords;
  /** Exact counts, grouped (1,234,567). */
  num: (n: number) => string;
  /** Compact counts for the chart axis (1.2M). */
  short: (n: number) => string;
  /** A 0–1 rate as a percentage; "—" for null. */
  pct: (r: number | null) => string;
}) {
  const t = data.totals;
  const fill = (s: string) => s.replace("{zone}", data.zone);
  const label = (b: string) =>
    data.bucket === "hour"
      ? `${b.slice(0, 10)} ${b.slice(11)}:00 (${data.zone})`
      : `${b} (${data.zone})`;
  const tick = (b: string) => (data.bucket === "hour" ? `${b.slice(11)}h` : b.slice(5));
  return (
    <section className="space-y-4" data-testid="costs-tokens">
      <h2 className="text-lg font-semibold">{w.tokens}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(
          [
            [w.hitRate, pct(t.hitRate), true],
            [w.tokensIn, num(t.tokensIn), false],
            [w.tokensCached, num(t.cachedIn), false],
            [w.tokensOut, num(t.tokensOut), false],
          ] as const
        ).map(([lab, value, main], i) => (
          <div
            key={i}
            className={`rounded border p-3 ${main ? "border-primary bg-primary text-on-primary" : LINE}`}
          >
            <div className="text-xs opacity-90">{lab}</div>
            <div className="text-xl font-semibold tabular-nums break-all">{value}</div>
          </div>
        ))}
      </div>
      <p className="text-xs opacity-70">{fill(w.tokensNote)}</p>
      {t.replies === 0 ? (
        <p className="text-sm" data-testid="costs-tokens-empty">
          {w.tokensEmpty}
        </p>
      ) : (
        <>
          <StackedBars
            title={w.chartTokens}
            buckets={data.rows.map((r) => r.bucket)}
            series={tokenBarSeries(data, w)}
            bucketLabel={(b) => {
              const r = data.rows.find((x) => x.bucket === b);
              return `${label(b)} · ${w.hitRate} ${pct(r?.hitRate ?? null)}`;
            }}
            tick={tick}
            usd={short}
            totalLabel={w.tokensTotal}
            hint={w.chartHint}
            describedBy="costs-tokens-users"
            testId="costs-chart-tokens"
          />
          <HitRateLine
            title={w.chartHitRate}
            rows={data.rows}
            pct={pct}
            label={label}
            tick={tick}
          />
          <div className="space-y-1" id="costs-tokens-users">
            <h3 className="text-base font-semibold">{w.tokensByUser}</h3>
            <div className={`${GRID} text-xs opacity-80 py-1 border-b ${LINE}`}>
              <span />
              <span className="text-right">{w.tokensIn}</span>
              <span className="text-right hidden sm:block">{w.tokensCached}</span>
              <span className="text-right">{w.tokensOut}</span>
              <span className="text-right hidden sm:block">{w.replies}</span>
              <span className="text-right">{w.hitRate}</span>
            </div>
            <VirtualList
              items={data.users}
              getKey={(u) => u.userId || "-guest"}
              name="dev-costs-token-users"
              hasMore={false}
              loading={false}
              onReachEnd={() => {}}
              total={data.users.length}
              estimateSize={52}
              testId="costs-token-users"
              renderItem={(u) => (
                <div
                  className={`${GRID} text-sm py-1.5 border-b ${LINE}`}
                  data-testid="costs-token-user"
                >
                  <span className="min-w-0">
                    <span className="block truncate">
                      {u.userId === "" ? w.guest : (u.name ?? w.noName)}
                    </span>
                    {u.userId ? (
                      <span className="block font-mono text-[0.7rem] opacity-70 truncate">
                        {u.userId}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-right tabular-nums">{num(u.tokensIn)}</span>
                  <span className="text-right tabular-nums hidden sm:block">{num(u.cachedIn)}</span>
                  <span className="text-right tabular-nums">{num(u.tokensOut)}</span>
                  <span className="text-right tabular-nums hidden sm:block">{num(u.replies)}</span>
                  <span className="text-right tabular-nums font-semibold text-[var(--brand)]">
                    {pct(u.hitRate)}
                  </span>
                </div>
              )}
            />
          </div>
        </>
      )}
    </section>
  );
}
