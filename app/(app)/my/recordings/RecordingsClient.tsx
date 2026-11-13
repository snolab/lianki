"use client";

/**
 * /my/recordings (docs/recordings.md): days newest first, more as the reader
 * nears the end (VirtualList, no pages); a day opens to its clips — time,
 * transcript, a player that never starts by itself — with Download day,
 * Delete day and Delete clip (each asks once, inline).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { Icon } from "@/app/components/icons";
import { VirtualList } from "@/app/components/VirtualList";
import {
  type ClipView,
  type DaySummary,
  clock,
  recordingRows,
  withoutClip,
  requestRecordings,
} from "@/lib/recordings-view";

const API = "/api/my/recordings";
const muted = "text-[oklch(0.42_0_0)] dark:text-[oklch(0.8_0_0)]";
const seal = "text-[oklch(0.5_0.18_25)] dark:text-[oklch(0.78_0.12_25)]";

export default function RecordingsClient() {
  const t = useIntlayer("my-recordings");
  const { locale } = useLocale();
  const [{ days, clips }, setRecordings] = useState({
    days: [] as DaySummary[],
    clips: new Map<string, ClipView[]>(),
  });
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dayErrors, setDayErrors] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState(false);
  const loadingDays = useRef(new Set<string>());
  const [confirm, setConfirm] = useState<string | null>(null);
  const busy = useRef(false);

  const loadMore = useCallback(() => {
    if (busy.current || !more) return;
    busy.current = true;
    setLoading(true);
    setError(false);
    const before = days.at(-1)?.day;
    fetch(`${API}${before ? `?before=${before}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((b: { days: DaySummary[]; more: boolean }) => {
        setRecordings((current) => ({
          ...current,
          days: [
            ...current.days,
            ...b.days.filter((x) => !current.days.some((y) => y.day === x.day)),
          ],
        }));
        setMore(b.more);
      })
      .catch(() => setError(true))
      .finally(() => {
        busy.current = false;
        setLoading(false);
      });
  }, [days, more]);

  useEffect(() => {
    loadMore();
    // Once, on mount: VirtualList asks for the rest.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDay = (day: string) => {
    if (loadingDays.current.has(day)) return;
    loadingDays.current.add(day);
    setDayErrors((errors) => {
      const next = new Set(errors);
      next.delete(day);
      return next;
    });
    requestRecordings<{ clips: ClipView[] }>(fetch, `?day=${day}`)
      .then((b) =>
        setRecordings((current) => ({
          ...current,
          clips: new Map(current.clips).set(day, b.clips),
        })),
      )
      .catch(() => setDayErrors((errors) => new Set(errors).add(day)))
      .finally(() => loadingDays.current.delete(day));
  };
  const toggle = (day: string) => {
    const next = new Set(open);
    if (next.has(day)) next.delete(day);
    else {
      next.add(day);
      if (!clips.has(day)) loadDay(day);
    }
    setOpen(next);
  };

  const delDay = async (day: string) => {
    setConfirm(null);
    setDeleteError(false);
    try {
      await requestRecordings(fetch, `?day=${day}`, "DELETE");
    } catch {
      setDeleteError(true);
      return;
    }
    setRecordings((current) => {
      const next = new Map(current.clips);
      next.delete(day);
      return { days: current.days.filter((x) => x.day !== day), clips: next };
    });
  };
  const delClip = async (c: ClipView) => {
    setConfirm(null);
    setDeleteError(false);
    try {
      await requestRecordings(fetch, `?clip=${c.id}`, "DELETE");
    } catch {
      setDeleteError(true);
      return;
    }
    // Requests can finish in either order: remove from the latest snapshot.
    setRecordings((current) => withoutClip(current.days, current.clips, c));
  };

  const dayName = (day: string) => {
    try {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: "full",
        timeZone: "UTC",
      }).format(Date.parse(`${day}T00:00:00Z`));
    } catch {
      return day;
    }
  };
  const time = (ms: number) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(ms);
    } catch {
      return new Date(ms).toISOString().slice(11, 19);
    }
  };
  const tz = typeof window === "undefined" ? 0 : new Date().getTimezoneOffset();

  /** "Delete for good?" with Delete / Cancel, in place of the button that asked. */
  const ask = (go: () => void) => (
    <span
      className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm"
      role="group"
      data-qa="recordings-confirm"
    >
      <span>{t.confirm}</span>
      <button
        type="button"
        onClick={go}
        className={`min-h-11 px-2 font-semibold underline ${seal}`}
      >
        {t.confirmYes}
      </button>
      <button type="button" onClick={() => setConfirm(null)} className="min-h-11 px-2 underline">
        {t.cancel}
      </button>
    </span>
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-8" data-qa="my-recordings">
      <a href="/my" className="mb-3 inline-flex items-center gap-1 text-sm underline">
        <Icon name="folder" />
        {t.back}
      </a>
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Icon name="microphone" />
        {t.title}
      </h1>
      <p className={`mt-1 text-sm ${muted}`}>{t.intro}</p>

      {deleteError && (
        <p role="alert" className={seal}>
          {t.deleteFailed}
        </p>
      )}

      <VirtualList
        items={recordingRows(days, open, clips, dayErrors)}
        getKey={(r) => r.key}
        name="my-recordings"
        hasMore={more}
        loading={loading}
        error={error}
        onReachEnd={loadMore}
        estimateSize={64}
        label={t.listLabel.value}
        testId="my-recordings-list"
        empty={
          <p className={`mt-6 text-sm ${muted}`} data-qa="my-recordings-empty">
            {t.empty}
          </p>
        }
        renderItem={(r) => {
          if (r.kind === "day") {
            const { day, clips: n, ms } = r.s;
            return (
              <div
                className="mt-4 flex flex-wrap items-center gap-2 border-b border-[oklch(0.5_0_0/0.2)] pb-2"
                data-qa="recordings-day"
                data-day={day}
              >
                <button
                  type="button"
                  aria-expanded={r.open}
                  onClick={() => toggle(day)}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span
                    aria-hidden
                    className={`inline-block transition-transform ${r.open ? "rotate-90" : ""}`}
                  >
                    ▸
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold">{dayName(day)}</span>
                    <span className={`block text-xs ${muted}`}>
                      {t.clips.value.replace("{n}", n.toLocaleString(locale))} · {clock(ms)}
                    </span>
                  </span>
                </button>
                {confirm === `d:${day}` ? (
                  ask(() => void delDay(day))
                ) : (
                  <>
                    <a
                      href={`${API}?day=${day}&archive=zip&tz=${tz}`}
                      download
                      data-qa="recordings-download"
                      className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm underline"
                    >
                      <Icon name="downloadSimple" />
                      {t.download}
                    </a>
                    <button
                      type="button"
                      data-qa="recordings-delete-day"
                      onClick={() => setConfirm(`d:${day}`)}
                      className={`flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm ${seal}`}
                    >
                      <Icon name="trash" />
                      {t.deleteDay}
                    </button>
                  </>
                )}
              </div>
            );
          }
          if (r.kind === "error")
            return (
              <div role="alert" className={`py-3 pl-6 text-sm ${seal}`}>
                <span>{t.loadFailed}</span>{" "}
                <button
                  type="button"
                  className="min-h-11 px-2 underline"
                  onClick={() => loadDay(r.day)}
                >
                  {t.retry}
                </button>
              </div>
            );
          if (r.kind === "loading")
            return <p className={`py-3 pl-6 text-sm ${muted}`}>{t.loading}</p>;
          const c = r.c;
          return (
            <div
              className="border-b border-[oklch(0.5_0_0/0.12)] py-2 pl-6"
              data-qa="recordings-clip"
              data-clip={c.id}
            >
              <div className={`flex flex-wrap items-center gap-2 text-xs ${muted}`}>
                <span className="font-medium tabular-nums">{time(c.at)}</span>
                <span className="tabular-nums">{clock(c.durationMs)}</span>
                {c.mode === "passive" && (
                  <span className="rounded border border-current px-1">{t.passive}</span>
                )}
                {c.speaker === "other" && (
                  <span className="rounded border border-current px-1">{t.otherVoice}</span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm">
                {c.text === null ? (
                  <span className={muted}>{t.unreadable}</span>
                ) : c.text ? (
                  c.text
                ) : (
                  <span className={muted}>{t.noText}</span>
                )}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {/* A player only: nothing plays until it is tapped. */}
                <audio
                  controls
                  preload="none"
                  src={`${API}?clip=${c.id}`}
                  className="h-9 max-w-full"
                />
                {confirm === `c:${c.id}` ? (
                  ask(() => void delClip(c))
                ) : (
                  <button
                    type="button"
                    data-qa="recordings-delete-clip"
                    aria-label={t.deleteClip.value}
                    title={t.deleteClip.value}
                    onClick={() => setConfirm(`c:${c.id}`)}
                    className={`flex size-11 items-center justify-center rounded-lg ${seal}`}
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
