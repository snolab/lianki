"use client";

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import type { WatchOverview } from "@/lib/repos/watchStatsD1";

const HEATMAP_WEEKS = 26;

const hours = (secs: number) => (secs / 3600).toFixed(1);

/** YYYY-MM-DD in local time — must match how the client wrote the day keys. */
const dayKey = (d: Date) => d.toLocaleDateString("en-CA");

/**
 * Colour a heatmap cell by how much was watched that day.
 *
 * Thresholds are absolute minutes rather than a percentile of the user's own
 * data: a relative scale makes a 5-minute day look identical to a 2-hour day
 * for someone just starting, which is the opposite of encouraging.
 */
function cellColor(secs: number): string {
  if (!secs) return "oklch(0.28 0.01 250)";
  const mins = secs / 60;
  if (mins < 10) return "oklch(0.45 0.07 150)";
  if (mins < 30) return "oklch(0.58 0.11 150)";
  if (mins < 60) return "oklch(0.68 0.15 150)";
  return "oklch(0.78 0.18 150)";
}

function Heatmap({ days }: { days: Record<string, number> }) {
  const today = new Date();
  const cells: { key: string; secs: number }[] = [];
  // Walk back whole weeks so columns line up as weeks, oldest on the left.
  const start = new Date(today);
  start.setDate(start.getDate() - HEATMAP_WEEKS * 7 + 1);
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d);
    cells.push({ key, secs: days[key] ?? 0 });
  }

  return (
    <div className="overflow-x-auto">
      <div
        className="grid grid-flow-col gap-[3px]"
        style={{ gridTemplateRows: "repeat(7, 12px)" }}
        role="img"
        aria-label="Daily input-time heatmap"
      >
        {cells.map(({ key, secs }) => (
          <div
            key={key}
            title={`${key} — ${secs ? `${Math.round(secs / 60)} min` : "nothing"}`}
            className="w-3 h-3 rounded-[2px]"
            style={{ background: cellColor(secs) }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * "ja" → "Japanese", in the reader's own locale.
 *
 * Raw BCP-47 tags are unreadable as a stat — "how many hours of ja" is not a
 * question anyone asks. Falls back to the tag when the runtime lacks
 * DisplayNames or the tag is unknown, which is better than showing nothing.
 */
function languageName(tag: string | null): string | null {
  if (!tag) return null;
  try {
    return (
      new Intl.DisplayNames(navigator.languages as string[], { type: "language" }).of(tag) ?? tag
    );
  } catch {
    return tag;
  }
}

export default function StatsClient() {
  const c = useIntlayer("stats-page");
  const [data, setData] = useState<WatchOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [identifyMsg, setIdentifyMsg] = useState<string | null>(null);

  const load = () =>
    fetch("/api/fsrs/watch/overview?top=20")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)));

  useEffect(() => {
    load();
  }, []);

  /** Videos whose language is still unknown — what the backfill would act on. */
  const unlabelled = data?.languages.find((l) => !l.lang)?.videos ?? 0;

  async function identify() {
    setIdentifying(true);
    setIdentifyMsg(null);
    try {
      const r = await fetch("/api/fsrs/watch/enrich", { method: "POST" });
      const body = await r.json().catch(() => ({}));
      // 501 means the server has no YOUTUBE_API_KEY. Say that plainly rather
      // than "failed" — it is a deployment gap the user can actually fix.
      if (r.status === 501) setIdentifyMsg(String(c.needsApiKey));
      else if (!r.ok) setIdentifyMsg(`HTTP ${r.status}${body?.error ? ` — ${body.error}` : ""}`);
      else {
        setIdentifyMsg(`${c.identified}: ${body.labelled ?? 0}/${body.checked ?? 0}`);
        await load();
      }
    } catch (e) {
      setIdentifyMsg(String((e as Error).message ?? e));
    } finally {
      setIdentifying(false);
    }
  }

  if (error) return <p className="p-8 text-red-400">{error}</p>;
  if (!data) return <p className="p-8 opacity-60">…</p>;

  const empty = data.videos === 0;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">{c.title}</h1>
        <p className="opacity-70 text-sm">{c.subtitle}</p>
      </header>

      {empty ? (
        <p className="opacity-70 text-sm leading-relaxed">{c.empty}</p>
      ) : (
        <>
          <section className="grid grid-cols-3 gap-4">
            {[
              { label: c.totalHours, value: hours(data.totalWall), hint: c.wallVsMedia },
              { label: c.streak, value: String(data.streak) },
              { label: c.videos, value: String(data.videos) },
            ].map((s) => (
              <div key={String(s.label)} className="rounded-lg bg-white/5 p-4">
                <div className="text-2xl font-semibold tabular-nums">{s.value}</div>
                <div className="text-xs opacity-70">{s.label}</div>
                {s.hint && (
                  <div className="text-[10px] opacity-40 mt-1 leading-tight">{s.hint}</div>
                )}
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <Heatmap days={data.days} />
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium opacity-80">{c.byLanguage}</h2>
            {data.languages.map((l) => (
              <div key={l.lang || "?"} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 opacity-80" title={l.lang || undefined}>
                  {languageName(l.lang) ?? c.unknownLanguage}
                </span>
                <div className="flex-1 h-2 rounded bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded"
                    style={{
                      width: `${data.totalWall ? (l.wall / data.totalWall) * 100 : 0}%`,
                      // Unlabelled is grey, not green: it is an absence of data,
                      // not a language you have studied.
                      background: l.lang ? "oklch(0.68 0.15 150)" : "oklch(0.55 0.02 250)",
                    }}
                  />
                </div>
                <span className="tabular-nums opacity-40 text-xs w-14 text-right">
                  {l.videos} {c.videosShort}
                </span>
                <span className="tabular-nums opacity-80 w-16 text-right font-medium">
                  {hours(l.wall)}h
                </span>
              </div>
            ))}

            {/*
              An unlabelled pile is the expected first state, not a failure: the
              audio language lives in ytInitialPlayerResponse, which neither a
              userscript sandbox nor an MV3 isolated content script can read. The
              server-side YouTube Data API is the only reliable source — so offer
              that action here instead of leaving an unexplained grey bar.
            */}
            {unlabelled > 0 && (
              <div className="mt-3 rounded-lg bg-white/5 p-3 text-xs space-y-2">
                <p className="opacity-70 leading-relaxed">{c.unlabelledExplainer}</p>
                <button
                  onClick={identify}
                  disabled={identifying}
                  className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40"
                >
                  {identifying ? c.identifying : c.identifyLanguages}
                </button>
                {identifyMsg && <p className="opacity-60">{identifyMsg}</p>}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium opacity-80">{c.topVideos}</h2>
            <ul className="space-y-1">
              {data.top.map((v) => (
                <li key={v.url} className="flex items-baseline gap-3 text-sm">
                  <a
                    href={v.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 truncate hover:underline"
                    title={v.url}
                  >
                    {v.title || v.url}
                  </a>
                  {v.coverage != null && (
                    <span className="text-xs opacity-50 tabular-nums shrink-0">
                      {Math.round(v.coverage * 100)}% {c.coverage}
                    </span>
                  )}
                  <span className="tabular-nums opacity-70 shrink-0">{hours(v.wall)}h</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
