"use client";

/**
 * A meeting's page (docs/meetings.md, "Playback"): the video fills the
 * screen with the transcript beside it from `md` up (under it on a phone).
 *
 * Media Source Extensions (ManagedMediaSource on iOS): the header bytes of
 * piece 0 (up to its first fragment), then pieces from the one holding the
 * wanted time, starting at its `fragOff` — that is what makes seeking work in
 * a recording MediaRecorder wrote without an index (`seekPlan`). About a
 * minute is kept ahead of the play head; what lies well behind is removed, so
 * an hour never sits in memory. Where MSE cannot play the type, the
 * download stream plays instead.
 *
 * Transcript rereads start only on a trusted button tap. Cancellation/navigation
 * closes that page's consumer without touching the archive or the media player.
 */
import Link from "next/link";
import { SealSwitch } from "@/app/components/SealSwitch";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { type ChunkMeta, clockOf, seekPlan, sizeOf } from "@/lib/meetings/core";
import { resumeLeftovers } from "@/lib/meetings/capture";
import type { MeetingView, StoredLine } from "@/lib/meetings/store";
import { publicCfg } from "@/lib/config-client";
import type { createConfiguredMeetingTranscription } from "@/lib/meeting-transcription/configured";
import type { TranscriptionStatus } from "@/lib/meeting-transcription/controller";

const AHEAD_S = 60;
const BEHIND_S = 30;

type MS = MediaSource;
function mediaSourceCtor(): (new () => MS) | null {
  const g = globalThis as unknown as {
    ManagedMediaSource?: new () => MS;
    MediaSource?: typeof MediaSource;
  };
  return g.ManagedMediaSource ?? g.MediaSource ?? null;
}

export default function MeetingPlayer({ id }: { id: string }) {
  const t = useIntlayer("my-meetings");
  const { locale } = useLocale();
  const search = useSearchParams();
  const video = useRef<HTMLVideoElement | null>(null);
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [chunks, setChunks] = useState<ChunkMeta[]>([]);
  const [lines, setLines] = useState<StoredLine[]>([]);
  const [failed, setFailed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [speakerConsent, setSpeakerConsent] = useState(false);
  const [speakerAvailable, setSpeakerAvailable] = useState(() =>
    Boolean(publicCfg("meetings.voiceprintAssets")),
  );
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionStatus, setTranscriptionStatus] = useState<TranscriptionStatus | null>(null);
  const transcription = useRef<{
    controller: AbortController;
    consumer: Awaited<ReturnType<typeof createConfiguredMeetingTranscription>>["consumer"] | null;
  } | null>(null);

  useEffect(() => {
    setTranscribing(false);
    setTranscriptionStatus(null);
    setSpeakerConsent(false);
    setSpeakerAvailable(Boolean(publicCfg("meetings.voiceprintAssets")));
    return () => {
      transcription.current?.controller.abort();
      transcription.current?.consumer?.close();
      transcription.current = null;
    };
  }, [id]);

  const onTranscribe = async (event: React.MouseEvent) => {
    if (
      !event.isTrusted ||
      transcription.current ||
      !meeting ||
      meeting.id !== id ||
      meeting.status === "recording"
    )
      return;
    const run = {
      controller: new AbortController(),
      consumer: null as
        | Awaited<ReturnType<typeof createConfiguredMeetingTranscription>>["consumer"]
        | null,
    };
    transcription.current = run;
    setTranscribing(true);
    setTranscriptionStatus({ phase: "starting" });
    try {
      const { createConfiguredMeetingTranscription } =
        await import("@/lib/meeting-transcription/configured");
      if (transcription.current !== run) return;
      const configured = await createConfiguredMeetingTranscription({
        meetingId: id,
        origin: location.origin,
        speakerConsent,
        onDraft() {},
        onStatus(status) {
          if (transcription.current === run) setTranscriptionStatus(status);
        },
        onEmbeddingStatus(status) {
          if (
            transcription.current === run &&
            ["assets-unavailable", "embedding-unavailable"].includes(status)
          )
            setSpeakerAvailable(false);
        },
      });
      if (transcription.current !== run) {
        configured.consumer.close();
        return;
      }
      run.consumer = configured.consumer;
      setSpeakerAvailable(configured.voiceprintConfigured);
      await run.consumer.runFinal({ userInitiated: true }, run.controller.signal);
      if (transcription.current !== run) return;
      const response = await fetch(`/api/my/meetings/${id}/lines`, {
        credentials: "same-origin",
        signal: run.controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("lines");
      const body = (await response.json()) as { lines: StoredLine[] };
      if (transcription.current === run) setLines(body.lines);
    } catch {
      if (transcription.current === run)
        setTranscriptionStatus({ phase: run.controller.signal.aborted ? "stopped" : "error" });
    } finally {
      run.consumer?.close();
      if (transcription.current === run) {
        transcription.current = null;
        setTranscribing(false);
      }
    }
  };
  const cancelTranscription = () => {
    const run = transcription.current;
    if (!run) return;
    transcription.current = null;
    run.controller.abort();
    run.consumer?.close();
    setTranscribing(false);
    setTranscriptionStatus({ phase: "stopped" });
  };

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setMeeting(null);
    setChunks([]);
    setLines([]);
    setMissing(false);
    setFailed(false);
    setConfirm(false);
    void resumeLeftovers();
    void (async () => {
      const r = await fetch(`/api/my/meetings/${id}`, { signal: controller.signal }).catch(
        () => null,
      );
      if (!current) return;
      if (!r?.ok) return setMissing(true);
      const b = (await r.json()) as { meeting: MeetingView; chunks: ChunkMeta[] };
      if (!current) return;
      setMeeting(b.meeting);
      setChunks(b.chunks);
      const l = await fetch(`/api/my/meetings/${id}/lines`, { signal: controller.signal }).catch(
        () => null,
      );
      if (l?.ok) {
        const body = (await l.json()) as { lines: StoredLine[] };
        if (current) setLines(body.lines);
      }
    })().catch(() => {
      if (current) setMissing(true);
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [id]);

  const av = chunks.filter((c) => c.track === "av").sort((a, b) => a.seq - b.seq);

  // ---------------------------------------------------------------- MSE
  useEffect(() => {
    const v = video.current;
    if (!v || !meeting || !av.length) return;
    const Ctor = mediaSourceCtor();
    const mime = meeting.mimeAv;
    const supported =
      Ctor &&
      (Ctor as unknown as { isTypeSupported(t: string): boolean }).isTypeSupported(mime) &&
      av[0].fragOff !== null;
    if (!supported) {
      v.src = `/api/my/meetings/${id}/download`;
      return;
    }
    const ms = new Ctor();
    (v as HTMLVideoElement & { disableRemotePlayback: boolean }).disableRemotePlayback = true;
    const url = URL.createObjectURL(ms);
    v.src = url;
    let sb: SourceBuffer | null = null;
    let header: Uint8Array | null = null;
    let next = 0; // the next av seq to append
    let gen = 0;
    let busy = false;
    let dead = false;
    const cache = new Map<number, Uint8Array>();

    const piece = async (seq: number): Promise<Uint8Array> => {
      const have = cache.get(seq);
      if (have) return have;
      const r = await fetch(`/api/my/meetings/${id}/chunks/av/${seq}`);
      if (!r.ok) throw new Error("piece");
      const b = new Uint8Array(await r.arrayBuffer());
      if (seq === 0) cache.set(0, b);
      return b;
    };
    const append = (b: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        if (!sb) return reject(new Error("no buffer"));
        const done = () => {
          sb!.removeEventListener("updateend", done);
          sb!.removeEventListener("error", fail);
          resolve();
        };
        const fail = () => {
          sb!.removeEventListener("updateend", done);
          sb!.removeEventListener("error", fail);
          reject(new Error("append"));
        };
        sb.addEventListener("updateend", done);
        sb.addEventListener("error", fail);
        sb.appendBuffer(b as Uint8Array<ArrayBuffer>);
      });
    const bufferedEnd = () => {
      const b = v.buffered;
      for (let i = 0; i < b.length; i++)
        if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) return b.end(i);
      return v.currentTime;
    };
    const trim = async () => {
      if (!sb || sb.updating || v.currentTime < BEHIND_S * 2) return;
      try {
        await new Promise<void>((resolve) => {
          sb!.addEventListener("updateend", () => resolve(), { once: true });
          sb!.remove(0, v.currentTime - BEHIND_S);
        });
      } catch {}
    };
    const fill = async () => {
      if (busy || dead || !sb) return;
      busy = true;
      const mine = gen;
      try {
        while (next < av.length && bufferedEnd() - v.currentTime < AHEAD_S) {
          const seq = av[next].seq;
          const b = await piece(seq);
          if (mine !== gen || dead) return;
          await append(b);
          next++;
        }
        if (next >= av.length && ms.readyState === "open" && !sb.updating) ms.endOfStream();
        await trim();
      } catch {
        if (mine === gen && !dead) setFailed(true);
      } finally {
        busy = false;
      }
    };
    /** Start appending at `sec`: header, then the piece holding it from its fragment. */
    const startAt = async (sec: number) => {
      const plan = seekPlan(av, sec * 1000);
      if (!plan || !sb) return;
      const mine = ++gen;
      busy = true;
      try {
        if (sb.updating) sb.abort();
        if (v.buffered.length)
          await new Promise<void>((resolve) => {
            sb!.addEventListener("updateend", () => resolve(), { once: true });
            sb!.remove(0, Number.POSITIVE_INFINITY);
          });
        if (!header) {
          const p0 = await piece(0);
          header = p0.slice(0, av[0].fragOff ?? 0);
        }
        const idx = av.findIndex((c) => c.seq === plan.seq);
        const b = await piece(plan.seq);
        if (mine !== gen || dead) return;
        if (plan.seq === 0 && plan.offset <= header.length) await append(b);
        else {
          await append(header);
          await append(b.slice(plan.offset));
        }
        next = idx + 1;
      } catch {
        if (mine === gen && !dead) setFailed(true);
      } finally {
        if (mine === gen) busy = false;
      }
      void fill();
    };
    const onSeeking = () => {
      const tt = v.currentTime;
      const b = v.buffered;
      for (let i = 0; i < b.length; i++)
        if (b.start(i) <= tt && b.end(i) > tt + 1) return void fill();
      void startAt(tt);
    };
    ms.addEventListener("sourceopen", () => {
      try {
        sb = ms.addSourceBuffer(mime);
        sb.mode = "segments";
        if (meeting.durationMs) ms.duration = meeting.durationMs / 1000;
      } catch {
        setFailed(true);
        return;
      }
      const t0 = Number(search.get("t") ?? 0);
      void startAt(Number.isFinite(t0) && t0 > 0 ? t0 : 0).then(() => {
        if (t0 > 0) v.currentTime = t0;
      });
    });
    v.addEventListener("timeupdate", fill);
    v.addEventListener("seeking", onSeeking);
    return () => {
      dead = true;
      v.removeEventListener("timeupdate", fill);
      v.removeEventListener("seeking", onSeeking);
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
    };
    // Rebuilt only when the meeting or its pieces change.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting?.id, av.length, id]);

  const seek = useCallback((ms: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    void v.play().catch(() => {});
  }, []);

  const remove = async () => {
    const r = await fetch(`/api/my/meetings/${id}`, { method: "DELETE" }).catch(() => null);
    if (r?.ok) location.assign("/my/meetings");
  };

  if (missing)
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link href="/my/meetings" className="text-gold-ink hover:underline">
          ← {t.back}
        </Link>
        <p className="mt-4">{t.loadFailed}</p>
      </main>
    );

  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const transcriptionText = !transcriptionStatus
    ? null
    : transcriptionStatus.phase === "error"
      ? t.transcriptionFailed
      : transcriptionStatus.phase === "stopped"
        ? t.transcriptionCancelled
        : transcriptionStatus.phase === "done"
          ? t.transcriptSaved
          : transcriptionStatus.phase === "backpressure"
            ? t.captionGap
            : t.transcribing;
  return (
    <main className="px-3 py-4 md:px-6" data-lk-private-screen="">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/my/meetings" className="text-sm text-gold-ink hover:underline">
          ← {t.back}
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold">{meeting?.title ?? ""}</h1>
      </div>
      {meeting && (
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {fmt.format(new Date(meeting.startedAt))} · {clockOf(meeting.durationMs)} ·{" "}
          {sizeOf(meeting.bytes)}
        </p>
      )}
      <div className="mt-3 grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="relative">
          {/* Plays only on the user's tap: the controls are the browser's own. */}
          <video
            ref={video}
            controls
            playsInline
            preload="metadata"
            aria-label={t.player.value}
            className="max-h-[80vh] w-full rounded-xl bg-gray-950"
          />
          {failed && (
            <div className="lk-glass absolute inset-x-3 bottom-14 rounded-xl border border-[var(--glass-line)] px-3 py-2 text-sm">
              ⚠ {t.playFailed}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              className="lk-btn lk-btn-secondary"
              href={`/api/my/meetings/${id}/download`}
              download
            >
              {t.download}
            </a>
            {lines.length > 0 && (
              <a
                className="lk-btn lk-btn-secondary"
                href={`/api/my/meetings/${id}/download?part=txt`}
                download
              >
                {t.downloadTxt}
              </a>
            )}
            {confirm ? (
              <span className="flex flex-wrap items-center gap-2">
                <span>{t.deleteConfirm}</span>
                <button
                  type="button"
                  className="lk-btn lk-btn-primary"
                  onClick={() => void remove()}
                >
                  {t.deleteYes}
                </button>
                <button
                  type="button"
                  className="lk-btn lk-btn-quiet"
                  onClick={() => setConfirm(false)}
                >
                  {t.cancel}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="lk-btn lk-btn-quiet"
                onClick={() => setConfirm(true)}
              >
                {t.delete}
              </button>
            )}
          </div>
        </div>
        <section aria-labelledby="lk-meet-transcript" className="min-w-0">
          <h2 id="lk-meet-transcript" className="mb-2 font-semibold">
            {t.transcript}
          </h2>
          <div className="mb-4 space-y-2 text-sm">
            <p>{t.tLocal}</p>
            <div className="flex items-center justify-between gap-4">
              <span id="lk-meet-speaker-consent-final">{t.speakerConsent}</span>
              <SealSwitch
                checked={speakerConsent}
                aria-labelledby="lk-meet-speaker-consent-final"
                disabled={transcribing || !speakerAvailable}
                onClick={() => setSpeakerConsent((previous) => !previous)}
              />
            </div>
            <p className="text-gray-600 dark:text-gray-400">{t.speakerPrivacy}</p>
            {!speakerAvailable && <p>{t.speakerUnavailable}</p>}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="lk-btn lk-btn-secondary"
                disabled={transcribing || !meeting || meeting.status === "recording"}
                onClick={onTranscribe}
              >
                {transcribing ? t.transcribing : t.transcribeAction}
              </button>
              {transcribing && (
                <button type="button" className="lk-btn lk-btn-quiet" onClick={cancelTranscription}>
                  {t.cancelTranscription}
                </button>
              )}
            </div>
            {transcriptionText && <p role="status">{transcriptionText}</p>}
          </div>
          {lines.length === 0 ? (
            <p className="text-sm text-gray-500">{t.noTranscript}</p>
          ) : (
            <ol className="space-y-1 md:max-h-[75vh] md:overflow-y-auto">
              {lines.map((l) => (
                <li key={`${l.track}-${l.startMs}`}>
                  <button
                    type="button"
                    onClick={() => seek(l.startMs)}
                    className="w-full rounded-lg px-2 py-1 text-start hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <span className="me-2 text-xs tabular-nums text-gray-500">
                      {clockOf(l.startMs)}
                    </span>
                    <span className="me-1 text-xs font-semibold">
                      {l.speaker === "unknown"
                        ? t.speakerOthers
                        : l.speaker && l.speaker !== l.track
                          ? l.speaker
                          : l.track === "me"
                            ? t.speakerMe
                            : t.speakerOthers}
                    </span>
                    <span className={l.source === "live" ? "text-gray-500" : ""}>{l.text}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}
