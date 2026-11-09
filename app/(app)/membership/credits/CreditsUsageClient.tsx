"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { longDateTime } from "@/lib/dates";
import type { GroupTotal, UsageEntry, UsageGroup } from "@/lib/payments/credit-usage";
import { useCredits } from "../use-credits";

interface Page {
  balance: number;
  entries: UsageEntry[];
  total: number;
  month: GroupTotal[];
  groups: UsageGroup[];
}

// Colours (oklch only, docs/design-principles.md); the same family as the wallet card.
const card =
  "rounded-2xl p-4 sm:p-6 shadow-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100";
const muted = "text-gray-600 dark:text-gray-400";
const link =
  "font-medium underline underline-offset-2 text-blue-600 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-200";
const field =
  "min-h-11 w-full rounded-lg border px-3 py-2 bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600";
const plus = "text-[oklch(0.45_0.14_150)] dark:text-[oklch(0.8_0.12_150)]";

const PAGE = 100;

/** The viewer's own time zone (dates, filters and the month are in it). */
const viewerZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/**
 * /membership/credits: every change to the user's credits — time, feature,
 * amount, balance after; a paid action as held · used · returned. Filters by
 * feature and date, this month's totals per feature, CSV export.
 */
export default function CreditsUsageClient() {
  const s = useIntlayer("credits-usage");
  const w = useIntlayer("wallet-card");
  const { credits, signed } = useCredits();
  const [group, setGroup] = useState<UsageGroup | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const tz = useMemo(viewerZone, []);

  const query = useMemo(() => {
    const q = new URLSearchParams({ tz });
    if (group) q.set("group", group);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    return q;
  }, [tz, group, from, to]);

  const load = useCallback(
    async (offset: number) => {
      setBusy(true);
      try {
        const q = new URLSearchParams(query);
        q.set("offset", String(offset));
        q.set("limit", String(PAGE));
        const res = await fetch(`/api/payments/credits/usage?${q}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as Page;
        setPage((prev) =>
          offset && prev ? { ...next, entries: [...prev.entries, ...next.entries] } : next,
        );
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [query],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const groupLabel = (g: UsageGroup) =>
    (s.groups as Record<string, { value: string }>)[g]?.value ??
    (w.reasons as Record<string, { value: string }>)[g]?.value ??
    g;
  const filtered = Boolean(group || from || to);
  const csv = `/api/payments/credits/usage?${new URLSearchParams([...query, ["format", "csv"]])}`;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6 space-y-4" data-credits-usage="">
      <Link
        href="/membership"
        className={`inline-flex min-h-11 items-center gap-1 text-sm ${link}`}
      >
        <span aria-hidden>←</span> {s.back.value}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Icon name="list" /> {s.title.value}
        </h1>
        <p className={`text-sm ${muted}`}>{s.intro.value}</p>
      </header>

      <section className={`${card} flex flex-wrap items-end justify-between gap-3`}>
        <div>
          <div className={`text-xs ${muted}`}>{s.balance.value}</div>
          <div className="text-3xl font-bold tabular-nums" data-usage-balance="">
            {page ? credits(page.balance) : "…"}
          </div>
        </div>
        <a
          href={csv}
          download
          className={`inline-flex min-h-11 items-center gap-1 text-sm ${link}`}
        >
          <Icon name="downloadSimple" /> {s.exportCsv.value}
        </a>
      </section>

      <section className={`${card} space-y-2`} aria-labelledby="usage-month">
        <h2 id="usage-month" className="font-semibold">
          {s.monthTitle.value}
        </h2>
        {page && page.month.length === 0 ? (
          <p className={`text-sm ${muted}`}>{s.monthEmpty.value}</p>
        ) : (
          <ul className="text-sm divide-y divide-gray-200 dark:divide-gray-700">
            {page?.month.map((m) => (
              <li key={m.group} className="flex flex-wrap justify-between gap-x-3 py-1.5">
                <button
                  type="button"
                  onClick={() => setGroup(m.group)}
                  className="min-h-9 text-left underline-offset-2 hover:underline"
                >
                  {groupLabel(m.group)}
                </button>
                <span className="tabular-nums">
                  {m.spent > 0 && s.spent.value.replace("{n}", credits(m.spent))}
                  {m.spent > 0 && m.added > 0 && " · "}
                  {m.added > 0 && (
                    <span className={plus}>{s.added.value.replace("{n}", credits(m.added))}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`${card} space-y-3`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className={muted}>{s.filterGroup.value}</span>
            <select
              className={field}
              value={group}
              onChange={(e) => setGroup(e.target.value as UsageGroup | "")}
              data-usage-group=""
            >
              <option value="">{s.allGroups.value}</option>
              {(page?.groups ?? []).map((g) => (
                <option key={g} value={g}>
                  {groupLabel(g)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className={muted}>{s.from.value}</span>
            <input
              type="date"
              className={field}
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className={muted}>{s.to.value}</span>
            <input
              type="date"
              className={field}
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        {filtered && (
          <button
            type="button"
            className={`min-h-11 text-sm ${link}`}
            onClick={() => {
              setGroup("");
              setFrom("");
              setTo("");
            }}
          >
            {s.clear.value}
          </button>
        )}

        {failed && (
          <p
            role="alert"
            className="text-sm text-[oklch(0.5_0.18_25)] dark:text-[oklch(0.78_0.14_25)]"
          >
            <Icon name="warning" className="me-1.5" />
            {s.failed.value}
          </p>
        )}
        {page && page.entries.length === 0 && !failed && (
          <p className={`text-sm ${muted}`}>{filtered ? s.noMatch.value : s.empty.value}</p>
        )}
        <ul className="divide-y divide-gray-200 dark:divide-gray-700 text-sm" data-usage-list="">
          {page?.entries.map((e) => (
            <li
              key={e.id}
              id={`usage-${e.id}`}
              className="flex items-start justify-between gap-3 py-2 target:bg-gold-100 dark:target:bg-gold-950"
              data-usage-entry={e.group}
            >
              <div className="min-w-0 space-y-0.5">
                <div className="font-medium">
                  {groupLabel(e.group)}
                  {e.passId === "pro-1m" && ` · ${w.oneMonth.value}`}
                  {e.passId === "pro-12m" && ` · ${w.twelveMonths.value}`}
                </div>
                <div className={`text-xs ${muted}`}>{longDateTime(e.at)}</div>
                {e.pending && (
                  <div className={`text-xs ${muted}`} data-usage-pending="">
                    {s.pending.value}
                  </div>
                )}
                {e.refundOf && (
                  <div className={`text-xs ${muted}`} data-usage-refund-of="">
                    <a href={`#usage-${e.refundOf.id}`} className={link}>
                      {s.refundOf.value
                        .replace("{what}", groupLabel(e.refundOf.group))
                        .replace("{date}", longDateTime(e.refundOf.at))}
                    </a>
                  </div>
                )}
                <div className={`text-xs ${muted}`}>
                  {s.balanceAfter.value.replace("{n}", credits(e.balanceAfter))}
                  {e.href && (
                    <>
                      {" · "}
                      <Link href={e.href} className={link}>
                        {s.open.value}
                      </Link>
                    </>
                  )}
                </div>
              </div>
              <span className={`shrink-0 font-semibold tabular-nums ${e.amount > 0 ? plus : ""}`}>
                {signed(e.amount)}
              </span>
            </li>
          ))}
        </ul>
        {page && page.entries.length < page.total && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void load(page.entries.length)}
            className={`min-h-11 w-full rounded-lg border text-sm font-medium border-gray-300 dark:border-gray-600 disabled:opacity-50`}
          >
            {s.loadMore.value}
          </button>
        )}
      </section>
    </main>
  );
}
