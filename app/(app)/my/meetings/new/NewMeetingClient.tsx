"use client";

/**
 * /my/meetings/new (docs/meetings.md, "Starting, and what everyone sees"):
 * what is captured, the line about the other people, Copy notice, the mic
 * switch, the transcript choice (three states, all visible), the browser
 * note, and Start — which acts on a trusted tap only.
 * Captions belong to this page and close on navigation; the archival recorder persists.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { SealSwitch } from "@/app/components/SealSwitch";
import { publicCfg } from "@/lib/config-client";
import { type Support, recordSupport } from "@/lib/meetings/core";
import {
  type RecState,
  type StartError,
  meetingRecorder,
  resumeLeftovers,
} from "@/lib/meetings/capture";
import type { createConfiguredMeetingTranscription } from "@/lib/meeting-transcription/configured";
import type { MeetingLine, MeetingTrack } from "@/lib/meeting-transcription/contracts";
import type { TranscriptionStatus } from "@/lib/meeting-transcription/controller";

type Choice = "none" | "local" | "cloud";
type CaptionConsumer = Awaited<ReturnType<typeof createConfiguredMeetingTranscription>>["consumer"];

export default function NewMeetingClient() {
  const t = useIntlayer("my-meetings");
  const { locale } = useLocale();
  const [support, setSupport] = useState<Support | null>(null);
  const [mic, setMic] = useState(true);
  const [transcript, setTranscript] = useState<Choice>("none");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<StartError | null>(null);
  const [rec, setRec] = useState<RecState | null>(null);
  const [speakerConsent, setSpeakerConsent] = useState(false);
  const [speakerAvailable, setSpeakerAvailable] = useState(() =>
    Boolean(publicCfg("meetings.voiceprintAssets")),
  );
  const [drafts, setDrafts] = useState<Record<MeetingTrack, MeetingLine | null>>({
    me: null,
    others: null,
  });
  const [captionStatus, setCaptionStatus] = useState<TranscriptionStatus | null>(null);
  const captions = useRef<CaptionConsumer | null>(null);
  const captionMeeting = useRef<string | null>(null);
  const captionGeneration = useRef(0);
  const mounted = useRef(false);
  const captionReady = useRef(false);
  const finishingCaptions = useRef(false);
  const finishCaptions = useCallback(() => {
    const consumer = captions.current;
    if (!consumer || !captionReady.current || finishingCaptions.current) return;
    finishingCaptions.current = true;
    const generation = captionGeneration.current;
    void consumer
      .finishLive()
      .catch(() => {
        if (mounted.current && generation === captionGeneration.current)
          setCaptionStatus({ phase: "error" });
      })
      .finally(() => {
        consumer.close();
        if (captions.current === consumer) {
          captions.current = null;
          captionReady.current = false;
          finishingCaptions.current = false;
        }
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    setSupport(
      recordSupport({
        ua: navigator.userAgent,
        hasDisplayMedia: Boolean(navigator.mediaDevices?.getDisplayMedia),
        hasRecorder: typeof MediaRecorder !== "undefined",
        mobile: (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile,
      }),
    );
    void resumeLeftovers();
    const unsubscribe = meetingRecorder().subscribe((next) => {
      setRec(next);
      // Drain only once capture has ended; stopping can still deliver its last PCM frames.
      if (next.phase === "ended" && next.meetingId === captionMeeting.current && captions.current) {
        finishCaptions();
      }
    });
    return () => {
      mounted.current = false;
      captionGeneration.current++;
      unsubscribe();
      captions.current?.close();
      captions.current = null;
    };
  }, [finishCaptions]);

  const busy = rec?.phase === "starting";
  const live = rec?.phase === "recording" || rec?.phase === "paused" || rec?.phase === "stopping";

  const onStart = async (e: React.MouseEvent) => {
    if (!e.isTrusted || !support?.ok || busy || live) return;
    setErr(null);
    const generation = ++captionGeneration.current;
    captions.current?.close();
    captions.current = null;
    captionMeeting.current = null;
    captionReady.current = false;
    finishingCaptions.current = false;
    setCaptionStatus(null);
    setDrafts({ me: null, others: null });
    const r = await meetingRecorder().start(
      {
        mic,
        transcript,
        titleWord: t.title.value,
        locale,
        cfg: {
          chunkSec: publicCfg("meetings.chunkSec"),
          maxMinutes: publicCfg("meetings.maxMinutes"),
          videoKbps: publicCfg("meetings.videoKbps"),
          frameRate: publicCfg("meetings.frameRate"),
          audioKbps: publicCfg("meetings.audioKbps"),
          trackKbps: publicCfg("meetings.trackKbps"),
          mimeTypes: publicCfg("meetings.mimeTypes"),
        },
      },
      e,
    );
    if (!mounted.current || generation !== captionGeneration.current) return;
    if (r && r !== "refused") setErr(r);
    else if (r === "refused") setErr("failed");
    if (r || transcript !== "local" || !mounted.current || generation !== captionGeneration.current)
      return;
    const recorder = meetingRecorder(),
      meetingId = recorder.state.meetingId;
    if (!meetingId || !["recording", "paused"].includes(recorder.state.phase)) return;
    setCaptionStatus({ phase: "starting" });
    try {
      const { createConfiguredMeetingTranscription } =
        await import("@/lib/meeting-transcription/configured");
      if (!mounted.current || generation !== captionGeneration.current) return;
      const configured = await createConfiguredMeetingTranscription({
        meetingId,
        origin: location.origin,
        speakerConsent,
        onDraft(line, track) {
          if (mounted.current && generation === captionGeneration.current)
            setDrafts((previous) => ({ ...previous, [track]: line }));
        },
        onStatus(status) {
          if (mounted.current && generation === captionGeneration.current) setCaptionStatus(status);
        },
        onEmbeddingStatus(status) {
          if (
            mounted.current &&
            generation === captionGeneration.current &&
            ["assets-unavailable", "embedding-unavailable"].includes(status)
          )
            setSpeakerAvailable(false);
        },
      });
      if (
        !mounted.current ||
        generation !== captionGeneration.current ||
        recorder.state.meetingId !== meetingId ||
        !["recording", "paused"].includes(recorder.state.phase)
      ) {
        configured.consumer.close();
        if (mounted.current && generation === captionGeneration.current)
          setCaptionStatus({ phase: "stopped" });
        return;
      }
      setSpeakerAvailable(configured.voiceprintConfigured);
      captions.current = configured.consumer;
      captionMeeting.current = meetingId;
      await configured.consumer.startLive({ userInitiated: true });
      if (!mounted.current || generation !== captionGeneration.current) {
        configured.consumer.close();
        return;
      }
      captionReady.current = true;
      if (meetingRecorder().state.phase === "ended") finishCaptions();
    } catch {
      if (mounted.current && generation === captionGeneration.current) {
        captions.current?.close();
        captions.current = null;
        setCaptionStatus({ phase: "error" });
      }
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(t.notice.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const choices: { id: Choice; label: string }[] = [
    { id: "none", label: t.tNone.value },
    { id: "local", label: t.tLocal.value },
    { id: "cloud", label: t.tCloud.value },
  ];
  const errText =
    err === "cancelled" ? t.errCancelled : err === "quota" ? t.errQuota : err ? t.errFailed : null;
  const why =
    support && !support.ok
      ? support.reason === "mobile"
        ? t.unsupportedMobile
        : t.unsupportedBrowser
      : null;
  const captionText = !captionStatus
    ? null
    : captionStatus.phase === "error"
      ? t.transcriptionFailed
      : captionStatus.phase === "done"
        ? t.transcriptSaved
        : captionStatus.phase === "stopped"
          ? t.transcriptionCancelled
          : captionStatus.phase === "backpressure"
            ? t.captionGap
            : captionStatus.phase === "live"
              ? t.liveCaptions
              : t.transcribing;

  return (
    <main className="mx-auto max-w-2xl px-4 py-8" data-lk-private-screen="">
      <Link href="/my/meetings" className="text-sm text-gold-ink hover:underline">
        ← {t.back}
      </Link>
      <h1 className="mt-2 text-3xl font-bold">{t.startTitle}</h1>
      <p className="mt-3">{t.whatCaptured}</p>
      <p className="mt-3 rounded-lg border-l-4 border-primary pl-3 text-gray-700 dark:text-gray-300">
        {t.yourCare}
      </p>
      <button type="button" className="lk-btn lk-btn-secondary mt-3" onClick={copy}>
        {copied ? t.copied : t.copyNotice}
      </button>

      <div className="mt-8 flex items-center justify-between gap-4">
        <span id="lk-meet-mic">{t.micSwitch}</span>
        <SealSwitch checked={mic} aria-labelledby="lk-meet-mic" onClick={() => setMic((m) => !m)} />
      </div>

      <div className="mt-6">
        <div id="lk-meet-tr" className="mb-2">
          {t.transcriptLabel}
        </div>
        <div
          role="radiogroup"
          aria-labelledby="lk-meet-tr"
          className="flex rounded-full border-2 border-primary p-0.5"
        >
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={transcript === c.id}
              onClick={() => setTranscript(c.id)}
              className={`flex-1 rounded-full px-3 py-2 text-sm font-medium transition-colors ${
                transcript === c.id
                  ? "bg-primary text-on-primary"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {transcript === "cloud" && <p className="mt-2 text-sm">{t.tCloudNote}</p>}
        {transcript === "local" && (
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span id="lk-meet-speaker-consent-live">{t.speakerConsent}</span>
              <SealSwitch
                checked={speakerConsent}
                aria-labelledby="lk-meet-speaker-consent-live"
                disabled={!speakerAvailable || busy || live}
                onClick={() => setSpeakerConsent((previous) => !previous)}
              />
            </div>
            <p className="text-gray-600 dark:text-gray-400">{t.speakerPrivacy}</p>
            {!speakerAvailable && <p>{t.speakerUnavailable}</p>}
          </div>
        )}
      </div>

      {support?.ok && support.tabSoundOnly && (
        <p className="mt-6 text-sm text-gray-600 dark:text-gray-400">{t.tabSoundOnly}</p>
      )}
      {why && <p className="mt-6 text-sm text-gray-600 dark:text-gray-400">{why}</p>}
      {live && <p className="mt-6 text-sm">{t.alreadyRecording}</p>}
      {errText && (
        <p role="alert" className="mt-6 text-sm">
          ⚠ {errText}
        </p>
      )}

      <button
        type="button"
        data-meeting-start=""
        className="lk-btn lk-btn-primary mt-8 w-full py-3 text-base"
        disabled={!support?.ok || busy || live}
        onClick={onStart}
      >
        {busy ? t.starting : t.start}
      </button>
      {captionStatus && (
        <section
          className="mt-6 space-y-2 rounded-xl border border-gray-200 p-4 dark:border-gray-700"
          aria-labelledby="lk-live-captions"
        >
          <h2 id="lk-live-captions" className="font-semibold">
            {t.liveCaptions}
          </h2>
          <p role="status" className="text-sm">
            {captionText}
          </p>
          {(["me", "others"] as const).map((track) =>
            drafts[track] ? (
              <p key={track} className="text-gray-600 dark:text-gray-300">
                <span className="me-2 font-medium">
                  {track === "me" ? t.speakerMe : t.speakerOthers}
                </span>
                {drafts[track].text}
              </p>
            ) : null,
          )}
          {live && <p className="text-xs text-gray-500">{t.captionLeave}</p>}
        </section>
      )}
    </main>
  );
}
