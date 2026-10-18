"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { appHref } from "@/lib/app-locale";
import { rankSites, siteStats, type SiteStat } from "@/lib/home-sites";
import {
  IMMERSION_DOMAINS,
  type ImmersionLanguage,
  type ImmersionSite,
  orderImmersionLanguages,
} from "@/lib/immersion-sites";
import { siteOf } from "@/lib/next-card";
import { readLocalStore } from "@/app/lib/localStore";
import type { HostGroup } from "@/app/lib/notesAdmin";

const LANG_KEY = "lk:home:lang";
const PINS_KEY = "lk:home:pins";

function readPins(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PINS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "12 · 3 due" style badge for a site the user has cards on. */
function StatBadge({ stat, dueLabel }: { stat: SiteStat | undefined; dueLabel: string }) {
  if (!stat) return null;
  return (
    <span className="ms-auto shrink-0 flex items-center gap-1 text-[11px] tabular-nums">
      <span className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-gray-600 dark:text-gray-300">
        {stat.count}
      </span>
      {stat.due > 0 && (
        <span className="rounded bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 font-medium text-amber-800 dark:text-amber-200">
          {stat.due} {dueLabel}
        </span>
      )}
    </span>
  );
}

function SiteRow({
  site,
  stat,
  pinned,
  onPin,
  labels,
  big = false,
}: {
  site: ImmersionSite;
  stat: SiteStat | undefined;
  pinned: boolean;
  onPin: () => void;
  labels: { pin: string; unpin: string; due: string };
  big?: boolean;
}) {
  return (
    <div className="group flex items-center gap-1.5 min-w-0">
      <button
        type="button"
        onClick={onPin}
        aria-pressed={pinned}
        aria-label={pinned ? labels.unpin : labels.pin}
        title={pinned ? labels.unpin : labels.pin}
        className={`shrink-0 text-sm leading-none ${
          pinned
            ? "text-amber-500"
            : "text-gray-300 dark:text-gray-700 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-amber-400"
        }`}
      >
        ★
      </button>
      <a
        href={site.url}
        target="_blank"
        rel="noopener noreferrer"
        title={site.note ? `${hostLabel(site.url)} — ${site.note}` : hostLabel(site.url)}
        className={`truncate hover:underline ${
          big
            ? "font-medium text-blue-700 dark:text-blue-300"
            : "text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
        }`}
      >
        {site.name}
      </a>
      <StatBadge stat={stat} dueLabel={labels.due} />
    </div>
  );
}

export default function HomeClient({
  locale,
  isLoggedIn,
  preferred,
}: {
  locale: string;
  isLoggedIn: boolean;
  preferred: ImmersionLanguage[];
}) {
  const t = useIntlayer("home-page");
  const ordered = useMemo(() => orderImmersionLanguages(preferred), [preferred]);
  const focus = preferred[0] ?? null;

  // One language at a time: the start page is for reading, not comparing.
  const [lang, setLang] = useState<ImmersionLanguage>(focus ?? ordered[0].code);
  const [pins, setPins] = useState<string[]>([]);
  const [stats, setStats] = useState<Map<string, SiteStat>>(new Map());

  // Both are per-browser conveniences; read after mount to keep SSR and
  // hydration in step.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (saved && ordered.some((l) => l.code === saved)) setLang(saved as ImmersionLanguage);
    } catch {}
    setPins(readPins());
  }, [ordered]);

  const refreshStats = useCallback(async () => {
    try {
      if (isLoggedIn) {
        const res = await fetch("/api/fsrs/hosts");
        if (!res.ok) return;
        const { hosts } = (await res.json()) as { hosts: HostGroup[] };
        // The hosts endpoint has already counted per exact host; fold those
        // into sites without re-deriving due-ness from rows we do not have.
        const merged = new Map<string, SiteStat>();
        for (const h of hosts) {
          const site = siteOf(h.sampleUrl);
          if (!site) continue;
          const s = merged.get(site) ?? { site, count: 0, due: 0, sampleUrl: h.sampleUrl };
          s.count += h.count;
          s.due += h.due;
          merged.set(site, s);
        }
        setStats(merged);
      } else {
        const { cards } = await readLocalStore();
        setStats(siteStats(cards.map((c) => ({ url: c.url, due: c.card.due }))));
      }
    } catch (err) {
      console.error("[Lianki] could not load site counts:", err);
    }
  }, [isLoggedIn]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  function pickLang(code: ImmersionLanguage) {
    setLang(code);
    try {
      localStorage.setItem(LANG_KEY, code);
    } catch {}
  }

  function togglePin(url: string) {
    setPins((prev) => {
      const next = prev.includes(url) ? prev.filter((p) => p !== url) : [...prev, url];
      try {
        localStorage.setItem(PINS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  const totalDue = useMemo(() => [...stats.values()].reduce((sum, s) => sum + s.due, 0), [stats]);

  // "Your sites": pinned matrix sites first (in pin order), then every site
  // the user has cards on that is not already pinned, most urgent first.
  const { matrixByUrl, nameBySite } = useMemo(() => {
    const byUrl = new Map<string, ImmersionSite>();
    // First matrix entry for a site names it — primaries are walked before
    // alternatives, so a shared site keeps its best-known name.
    const bySite = new Map<string, string>();
    for (const d of IMMERSION_DOMAINS)
      for (const cell of Object.values(d.sites)) {
        byUrl.set(cell.primary.url, cell.primary);
        if (cell.alt) byUrl.set(cell.alt.url, cell.alt);
        for (const site of [cell.primary, cell.alt]) {
          const key = site && siteOf(site.url);
          if (site && key && !bySite.has(key)) bySite.set(key, site.name);
        }
      }
    return { matrixByUrl: byUrl, nameBySite: bySite };
  }, []);

  const yourSites = useMemo(() => {
    const out: Array<{ key: string; name: string; url: string; stat?: SiteStat; pinned: boolean }> =
      [];
    const seen = new Set<string>();
    for (const url of pins) {
      const site = matrixByUrl.get(url);
      const s = siteOf(url);
      if (!site || !s) continue;
      seen.add(s);
      out.push({ key: url, name: site.name, url, stat: stats.get(s), pinned: true });
    }
    for (const stat of rankSites(stats)) {
      if (seen.has(stat.site)) continue;
      out.push({
        key: stat.site,
        name: nameBySite.get(stat.site) ?? stat.site,
        url: `https://${stat.site}`,
        stat,
        pinned: false,
      });
    }
    return out;
  }, [pins, stats, matrixByUrl, nameBySite]);

  const labels = { pin: t.pin.value, unpin: t.unpin.value, due: t.due.value };

  return (
    <main className="max-w-6xl mx-auto px-4 py-6">
      {/* Top bar: review + language tabs */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <Link
          href={appHref("/next", locale)}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2"
        >
          <span aria-hidden>▶</span>
          {t.review}
          {totalDue > 0 && (
            <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs tabular-nums">
              {totalDue}
            </span>
          )}
        </Link>
        <div
          role="tablist"
          aria-label={t.languages.value}
          className="flex flex-wrap items-center gap-1.5 ms-auto"
        >
          {ordered.map((l) => {
            const on = l.code === lang;
            return (
              <button
                key={l.code}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => pickLang(l.code)}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  on
                    ? "border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500"
                    : "border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500"
                }`}
              >
                {l.code === focus && (
                  <span aria-hidden className="me-1">
                    ★
                  </span>
                )}
                <span lang={l.code}>{l.native}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Your sites */}
      <section className="mb-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">
          {t.yourSites}
        </h2>
        {yourSites.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t.yourSitesEmpty}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {yourSites.map((s) => (
              <li
                key={s.key}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-sm"
              >
                {s.pinned && (
                  <button
                    type="button"
                    onClick={() => togglePin(s.url)}
                    aria-label={labels.unpin}
                    title={labels.unpin}
                    className="text-amber-500 text-sm leading-none"
                  >
                    ★
                  </button>
                )}
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-blue-700 dark:text-blue-300 hover:underline"
                >
                  {s.name}
                </a>
                <StatBadge stat={s.stat} dueLabel={labels.due} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Topic grid for the active language */}
      <section lang={lang}>
        <ul className="grid gap-x-6 gap-y-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          {IMMERSION_DOMAINS.map((d) => {
            const { primary, alt } = d.sites[lang];
            return (
              <li
                key={d.key}
                className="min-w-0 border-t border-gray-200 dark:border-gray-800 pt-2"
              >
                <h3
                  lang={locale}
                  className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 truncate mb-1"
                  title={d.blurb}
                >
                  {d.title}
                </h3>
                <SiteRow
                  site={primary}
                  stat={stats.get(siteOf(primary.url) ?? "")}
                  pinned={pins.includes(primary.url)}
                  onPin={() => togglePin(primary.url)}
                  labels={labels}
                  big
                />
                {alt && (
                  <SiteRow
                    site={alt}
                    stat={stats.get(siteOf(alt.url) ?? "")}
                    pinned={pins.includes(alt.url)}
                    onPin={() => togglePin(alt.url)}
                    labels={labels}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <footer className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
        <span>{t.hint}</span>
        <Link
          href={appHref("/lab/immersion", locale)}
          className="text-blue-600 dark:text-blue-400 hover:underline"
        >
          {t.fullMatrix} →
        </Link>
      </footer>
    </main>
  );
}
