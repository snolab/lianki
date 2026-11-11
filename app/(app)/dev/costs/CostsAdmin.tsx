"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { VirtualList } from "@/app/components/VirtualList";
import { useInfiniteList } from "@/app/components/useInfiniteList";
import { CREDITS_PER_USD } from "@/lib/payments/credits";
import { MARGIN } from "@/lib/payments/prices";
import { CostMatrix, HEAT_CSS, HeatLegend, type Matrix } from "./CostMatrix";
import { freePaidSeries, featureSeries, StackedBars, TopAccounts } from "./CostCharts";

/**
 * /dev/costs: the cost ledger (docs/payments.md, "Cost ledger") through
 * /api/dev/costs. A date range (JST days), totals, then by day, by feature
 * and by account — free and paid side by side. The day and account tables are
 * VirtualLists; accounts load in batches as the list scrolls (no pages).
 * Charts (cost per day and per hour, stacked by service or free/paid; the top
 * accounts) and the day × service and hour × service tables (CostMatrix).
 */

type Totals = {
  freeMicro: number;
  freeCalls: number;
  paidMicro: number;
  paidCredits: number;
  paidCalls: number;
};
type Summary = {
  range: { from: string; to: string };
  totals: Totals;
  byDay: ({ day: string } & Totals)[];
  byFeature: ({ feature: string } & Totals)[];
};
type UserRow = { userId: string; name: string | null } & Totals;

/** The hourly view's choices; the server caps it at COSTS_MAX_HOURS. */
const HOUR_CHOICES = [24, 48, 72, 168] as const;
const MAX_HOURS = 168;

const JST = 9 * 3600_000;
const day = (ms: number) => new Date(ms + JST).toISOString().slice(0, 10);
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const LINE = "border-[oklch(0.88_0_0)] dark:border-[oklch(0.35_0_0)]";
const GRID =
  "grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,5.5rem))] sm:grid-cols-[minmax(0,1fr)_repeat(5,minmax(0,6.5rem))] gap-x-2 items-baseline";

export default function CostsAdmin() {
  const c = useIntlayer("dev-costs");
  const { locale } = useLocale();
  const today = useMemo(() => day(Date.now()), []);
  const [from, setFrom] = useState(() => day(Date.now() - 29 * 86400_000));
  const [to, setTo] = useState(today);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);

  const usd = useMemo(() => {
    const f = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
    return (micro: number) => f.format(micro / 1e6);
  }, [locale]);
  const num = useMemo(() => {
    const f = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    return (n: number) => f.format(n);
  }, [locale]);

  const range = from && to && from <= to ? `from=${from}&to=${to}` : null;

  useEffect(() => {
    if (!range) return;
    let live = true;
    setFailed(false);
    fetch(`/api/dev/costs?${range}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Summary>) : Promise.reject(r.status)))
      .then((s) => live && setSummary(s))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [range]);

  const [hours, setHours] = useState<number>(48);
  const [days, setDays] = useState<Matrix | null>(null);
  const [hourly, setHourly] = useState<Matrix | null>(null);
  const [split, setSplit] = useState<"service" | "paid">("service");
  useEffect(() => {
    if (!range) return;
    let live = true;
    const get = (q: string, set: (m: Matrix | null) => void) =>
      fetch(`/api/dev/costs?${range}&${q}`, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<Matrix>) : Promise.reject(r.status)))
        .then((m) => live && set(m))
        .catch(() => live && setFailed(true));
    void get("view=days", setDays);
    void get(`view=hours&hours=${hours}`, setHourly);
    return () => {
      live = false;
    };
  }, [range, hours]);
  const usdShort = useMemo(() => {
    const f = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumSignificantDigits: 3,
    });
    return (micro: number) => f.format(micro / 1e6);
  }, [locale]);
  const series = (m: Matrix) =>
    split === "service"
      ? featureSeries(m, c.other.value)
      : freePaidSeries(m, c.freeCost.value, c.paidCost.value);
  const describe = (lab: (b: string) => string) => (b: string, f: string, x: Totals | undefined) =>
    fill(c.cellRead.value, {
      bucket: lab(b),
      feature: f,
      free: usd(x?.freeMicro ?? 0),
      paid: usd(x?.paidMicro ?? 0),
    });
  const hourLabel = (h: string) => `${h.slice(0, 10)} ${h.slice(11)}:00`;
  const hourShort = (h: string) => `${h.slice(5, 10)} ${h.slice(11)}h`;
  // On the axis: the hour, with the date at midnight.
  const hourTick = (h: string) => (h.endsWith("T00") ? h.slice(5, 10) : `${h.slice(11)}h`);

  const fetchUsers = useCallback(
    async (cursor: number | null, size: number) => {
      const r = await fetch(
        `/api/dev/costs?${range}&view=users&offset=${cursor ?? 0}&limit=${size}`,
        { cache: "no-store" },
      );
      if (!r.ok) throw new Error(String(r.status));
      const b = (await r.json()) as { rows: UserRow[]; total: number; next: number | null };
      return { items: b.rows, next: b.next, total: b.total };
    },
    [range],
  );
  const users = useInfiniteList<UserRow, number>({
    fetchBatch: fetchUsers,
    getKey: (u) => u.userId || "-guest",
    deps: [range],
    enabled: !!range,
  });

  const t = summary?.totals;
  const maxDay = Math.max(1, ...(summary?.byDay ?? []).map((d) => d.freeMicro + d.paidMicro));

  const head = (
    <div className={`${GRID} text-xs opacity-80 py-1 border-b ${LINE}`}>
      <span />
      <span className="text-right">{c.freeCost}</span>
      <span className="text-right">{c.paidCost}</span>
      <span className="text-right hidden sm:block">{c.charged}</span>
      <span className="text-right hidden sm:block">{c.calls}</span>
      <span className="text-right">{c.totalCost}</span>
    </div>
  );
  const cells = (x: Totals) => (
    <>
      <span className="text-right tabular-nums">{usd(x.freeMicro)}</span>
      <span className="text-right tabular-nums">{usd(x.paidMicro)}</span>
      <span className="text-right tabular-nums hidden sm:block">{num(x.paidCredits)}</span>
      <span className="text-right tabular-nums hidden sm:block">
        {num(x.freeCalls + x.paidCalls)}
      </span>
      <span className="text-right tabular-nums font-semibold text-[var(--brand)]">
        {usd(x.freeMicro + x.paidMicro)}
      </span>
    </>
  );

  return (
    <div className="space-y-6" data-testid="costs-admin">
      <p className="text-sm opacity-80">{c.intro}</p>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex flex-col text-sm gap-1">
          {c.from}
          <input
            type="date"
            value={from}
            max={to || today}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="costs-from"
            className={`min-h-9 px-2 rounded border bg-transparent ${LINE}`}
          />
        </label>
        <label className="flex flex-col text-sm gap-1">
          {c.to}
          <input
            type="date"
            value={to}
            min={from}
            max={today}
            onChange={(e) => setTo(e.target.value)}
            data-testid="costs-to"
            className={`min-h-9 px-2 rounded border bg-transparent ${LINE}`}
          />
        </label>
      </div>

      {failed ? (
        <p role="alert" className="text-sm font-medium">
          <span aria-hidden="true">⚠ </span>
          {c.loadFailed}
        </p>
      ) : null}

      {t ? (
        <section className="space-y-2" data-testid="costs-totals">
          <h2 className="text-lg font-semibold">{c.totals}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              [c.totalCost, usd(t.freeMicro + t.paidMicro), true],
              [c.freeCost, usd(t.freeMicro), false],
              [c.paidCost, usd(t.paidMicro), false],
              [c.charged, num(t.paidCredits), false],
            ].map(([label, value, main], i) => (
              <div
                key={i}
                className={`rounded border p-3 ${main ? "border-primary bg-primary text-on-primary" : LINE}`}
              >
                <div className="text-xs opacity-90">{label}</div>
                <div className="text-xl font-semibold tabular-nums break-all">{value}</div>
              </div>
            ))}
          </div>
          <p className="text-xs opacity-70">
            {fill(c.note.value, { perUsd: CREDITS_PER_USD, margin: MARGIN })}
          </p>
          {summary && summary.byDay.length === 0 ? (
            <p className="text-sm" data-testid="costs-empty">
              {c.empty}
            </p>
          ) : null}
        </section>
      ) : null}

      {summary && summary.byFeature.length > 0 ? (
        <section className="space-y-1">
          <h2 className="text-lg font-semibold">{c.byFeature}</h2>
          {head}
          <div data-testid="costs-features">
            {summary.byFeature.map((f) => (
              <div key={f.feature} className={`${GRID} text-sm py-1.5 border-b ${LINE}`}>
                <span className="font-mono text-xs break-all">{f.feature}</span>
                {cells(f)}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <style>{HEAT_CSS}</style>
      {days || hourly ? (
        <section className="space-y-4" data-testid="costs-charts">
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <h2 className="text-lg font-semibold">{c.charts}</h2>
            <div role="group" className="flex gap-1 text-sm">
              {(
                [
                  ["service", c.byService],
                  ["paid", c.freeVsPaid],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={split === k}
                  onClick={() => setSplit(k)}
                  data-testid={`costs-split-${k}`}
                  className={`min-h-9 px-3 rounded border ${split === k ? "border-primary bg-primary text-on-primary" : LINE}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {days ? (
            <StackedBars
              title={c.chartDays.value}
              buckets={days.rows.map((r) => r.bucket)}
              series={series(days)}
              bucketLabel={(b) => b}
              tick={(b) => b.slice(5)}
              usd={usdShort}
              totalLabel={c.totalCost.value}
              hint={c.chartHint.value}
              describedBy="costs-day-matrix"
              testId="costs-chart-days"
            />
          ) : null}
          {hourly ? (
            <StackedBars
              title={c.chartHours.value}
              buckets={hourly.rows.map((r) => r.bucket)}
              series={series(hourly)}
              bucketLabel={(b) => `${hourLabel(b)} JST`}
              tick={hourTick}
              usd={usdShort}
              totalLabel={c.totalCost.value}
              hint={c.chartHint.value}
              describedBy="costs-hour-matrix"
              testId="costs-chart-hours"
            />
          ) : null}
          <TopAccounts
            title={c.topAccounts.value}
            rows={users.items.slice(0, 10).map((u) => ({
              key: u.userId || "-guest",
              name: u.userId === "" ? c.guest.value : (u.name ?? c.noName.value),
              freeMicro: u.freeMicro,
              paidMicro: u.paidMicro,
            }))}
            usd={usdShort}
            free={c.freeCost.value}
            paid={c.paidCost.value}
          />
        </section>
      ) : null}

      {days && days.rows.length > 0 ? (
        <section className="space-y-1" id="costs-day-matrix">
          <h2 className="text-lg font-semibold">{c.byDayFeature}</h2>
          <div className="flex flex-wrap gap-3 items-center justify-between">
            <p className="text-xs opacity-80">{c.cellNote}</p>
            <HeatLegend less={c.less} more={c.more} />
          </div>
          <CostMatrix
            matrix={days}
            label={(b) => b}
            totalLabel={c.totalCost}
            usd={usdShort}
            testId="costs-matrix-days"
            name="dev-costs-days-matrix"
            describe={describe((b) => b)}
          />
        </section>
      ) : null}

      {hourly ? (
        <section className="space-y-1" id="costs-hour-matrix">
          <div className="flex flex-wrap gap-3 items-end justify-between">
            <h2 className="text-lg font-semibold">{c.byHourFeature}</h2>
            <label className="flex flex-col text-sm gap-1">
              {c.hours}
              <select
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                data-testid="costs-hours"
                className={`min-h-9 px-2 rounded border bg-[var(--background)] ${LINE}`}
              >
                {HOUR_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {fill(c.hoursOption.value, { n })}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-3 items-center justify-between">
            <p className="text-xs opacity-80">{c.cellNote}</p>
            <HeatLegend less={c.less} more={c.more} />
          </div>
          <CostMatrix
            matrix={hourly}
            label={hourShort}
            totalLabel={c.totalCost}
            usd={usdShort}
            testId="costs-matrix-hours"
            name="dev-costs-hours-matrix"
            describe={describe(hourLabel)}
          />
          <p className="text-xs opacity-70">{fill(c.hourNote.value, { max: MAX_HOURS })}</p>
        </section>
      ) : null}

      {summary && summary.byDay.length > 0 ? (
        <section className="space-y-1">
          <h2 className="text-lg font-semibold">{c.byDay}</h2>
          {head}
          <VirtualList
            items={summary.byDay}
            getKey={(d) => d.day}
            hasMore={false}
            loading={false}
            onReachEnd={() => {}}
            total={summary.byDay.length}
            estimateSize={44}
            testId="costs-days"
            renderItem={(d) => (
              <div className={`py-1.5 border-b ${LINE}`}>
                <div className={`${GRID} text-sm`}>
                  <span className="font-mono text-xs">{d.day}</span>
                  {cells(d)}
                </div>
                <div className="h-1 mt-1 rounded bg-[oklch(0.9_0.01_80)] dark:bg-[oklch(0.3_0.01_65)]">
                  <div
                    className="h-1 rounded bg-primary"
                    style={{ width: `${((d.freeMicro + d.paidMicro) / maxDay) * 100}%` }}
                  />
                </div>
              </div>
            )}
          />
        </section>
      ) : null}

      {range ? (
        <section className="space-y-1">
          <h2 className="text-lg font-semibold">{c.byUser}</h2>
          {head}
          <VirtualList
            items={users.items}
            getKey={(u) => u.userId || "-guest"}
            name="dev-costs-users"
            hasMore={users.hasMore}
            loading={users.loading}
            error={users.error}
            total={users.total}
            onReachEnd={users.loadMore}
            estimateSize={52}
            testId="costs-users"
            renderItem={(u, i) => (
              <div className={`${GRID} text-sm py-1.5 border-b ${LINE}`} data-testid="costs-user">
                <span className="min-w-0">
                  <span className="block truncate">
                    {i < 3 && u.freeMicro + u.paidMicro > 0 ? (
                      <span className="text-[var(--brand)] font-semibold mr-1">#{i + 1}</span>
                    ) : null}
                    {u.userId === "" ? c.guest : (u.name ?? c.noName)}
                  </span>
                  {u.userId ? (
                    <span className="block font-mono text-[0.7rem] opacity-70 truncate">
                      {u.userId}
                    </span>
                  ) : null}
                </span>
                {cells(u)}
              </div>
            )}
          />
        </section>
      ) : null}
    </div>
  );
}
