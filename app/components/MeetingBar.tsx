"use client";

/**
 * The floating "Recording" bar (docs/meetings.md, "Recording indicator"): a
 * glass bar at the bottom of every Lianki page in the tab while a meeting
 * records — a red dot and the word, elapsed time, size, pieces waiting,
 * Pause/Resume and Stop. After the end: "Recording saved · Open". Renders
 * nothing while idle, and nothing at all unless meetings are open to the
 * account (`on`, from the app layout). The recorder is only loaded once a
 * meeting has started in this tab, so other pages pay nothing.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { clockOf, sizeOf } from "@/lib/meetings/core";
import type { MeetingRecorder, RecState } from "@/lib/meetings/capture";

const KEY = "__lkMeeting";

export function MeetingBar({ on }: { on: boolean }) {
  const [rec, setRec] = useState<MeetingRecorder | null>(null);
  const [st, setSt] = useState<RecState | null>(null);
  const [, tick] = useState(0);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!on) return;
    // The singleton exists only once a meeting started in this tab (lib/meetings/capture.ts).
    const have = (globalThis as Record<string, unknown>)[KEY] as MeetingRecorder | undefined;
    if (have) {
      setRec(have);
      return;
    }
    const h = () => {
      const r = (globalThis as Record<string, unknown>)[KEY] as MeetingRecorder | undefined;
      if (r) setRec(r);
    };
    addEventListener("lk-meeting", h);
    return () => removeEventListener("lk-meeting", h);
  }, [on]);

  useEffect(() => {
    if (!rec) return;
    return rec.subscribe((s) => {
      setSt(s);
      if (s.phase === "recording") setHidden(false);
    });
  }, [rec]);

  const running = st?.phase === "recording";
  useEffect(() => {
    if (!running) return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [running]);

  if (!on || !rec || !st || st.phase === "idle" || st.phase === "starting" || hidden) return null;
  return <Bar rec={rec} st={st} onHide={() => setHidden(true)} />;
}

function Bar({ rec, st, onHide }: { rec: MeetingRecorder; st: RecState; onHide: () => void }) {
  const t = useIntlayer("my-meetings");
  const ended = st.phase === "ended";
  const stopNote =
    st.reason === "max"
      ? t.stoppedMax
      : st.reason === "quota"
        ? t.stoppedQuota
        : st.reason === "refused"
          ? t.stoppedRefused
          : null;
  return (
    <div
      role="status"
      data-meeting-bar={st.phase}
      className="lk-glass fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-[var(--lk-z-overlay-toast)] mx-auto flex max-w-[40rem] flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-[var(--glass-line)] px-4 py-2 text-sm shadow-[0_8px_24px_-10px_oklch(0.22_0.015_65/0.4)]"
    >
      {ended ? (
        <>
          <span className="font-medium">{stopNote ?? t.saved}</span>
          {st.waiting > 0 && <span>{t.waiting.value.replace("{n}", String(st.waiting))}</span>}
          {st.meetingId && (
            <Link
              href={`/my/meetings/${st.meetingId}`}
              className="font-medium text-gold-ink underline"
            >
              {t.open}
            </Link>
          )}
          <button
            type="button"
            className="ms-auto px-2 text-lg leading-none"
            aria-label={t.dismiss.value}
            onClick={onHide}
          >
            ×
          </button>
        </>
      ) : (
        <>
          <span className="flex items-center gap-2 font-semibold">
            <span
              aria-hidden
              className={`inline-block size-3 rounded-full bg-primary ${st.phase === "recording" ? "animate-pulse" : "opacity-50"}`}
            />
            {st.phase === "paused" ? t.paused : t.recording}
          </span>
          <span className="tabular-nums">{clockOf(rec.clock())}</span>
          <span className="tabular-nums text-gray-600 dark:text-gray-400">{sizeOf(st.bytes)}</span>
          {st.waiting > 0 && (
            <span className="text-gray-600 dark:text-gray-400">
              {t.waiting.value.replace("{n}", String(st.waiting))}
            </span>
          )}
          {!st.roomAudio && (
            <span className="text-gray-600 dark:text-gray-400">{t.noRoomAudio}</span>
          )}
          {st.micLost && (
            <button type="button" className="underline" onClick={() => void rec.resumeMic()}>
              ⚠ {t.micLost} · {t.resumeMic}
            </button>
          )}
          <span className="ms-auto flex gap-2">
            {st.phase === "paused" ? (
              <button
                type="button"
                className="lk-btn lk-btn-secondary py-1"
                onClick={() => rec.resume()}
              >
                {t.resume}
              </button>
            ) : (
              <button
                type="button"
                className="lk-btn lk-btn-secondary py-1"
                disabled={st.phase === "stopping"}
                onClick={() => rec.pause()}
              >
                {t.pause}
              </button>
            )}
            <button
              type="button"
              className="lk-btn lk-btn-primary py-1"
              disabled={st.phase === "stopping"}
              onClick={() => void rec.stop("user")}
            >
              ■ {t.stop}
            </button>
          </span>
        </>
      )}
    </div>
  );
}
