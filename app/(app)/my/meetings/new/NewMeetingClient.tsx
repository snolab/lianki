"use client";

/**
 * /my/meetings/new (docs/meetings.md, "Starting, and what everyone sees"):
 * what is captured, the line about the other people, Copy notice, the mic
 * switch, the transcript choice (three states, all visible), the browser
 * note, and Start — which acts on a trusted tap only.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
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

type Choice = "none" | "local" | "cloud";

export default function NewMeetingClient() {
  const t = useIntlayer("my-meetings");
  const { locale } = useLocale();
  const [support, setSupport] = useState<Support | null>(null);
  const [mic, setMic] = useState(true);
  const [transcript, setTranscript] = useState<Choice>("none");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<StartError | null>(null);
  const [rec, setRec] = useState<RecState | null>(null);

  useEffect(() => {
    setSupport(
      recordSupport({
        ua: navigator.userAgent,
        hasDisplayMedia: Boolean(navigator.mediaDevices?.getDisplayMedia),
        hasRecorder: typeof MediaRecorder !== "undefined",
        mobile: (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile,
      }),
    );
    void resumeLeftovers();
    return meetingRecorder().subscribe(setRec);
  }, []);

  const busy = rec?.phase === "starting";
  const live = rec?.phase === "recording" || rec?.phase === "paused" || rec?.phase === "stopping";

  const onStart = async (e: React.MouseEvent) => {
    if (!e.isTrusted || !support?.ok || busy || live) return;
    setErr(null);
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
    if (r && r !== "refused") setErr(r);
    else if (r === "refused") setErr("failed");
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
    </main>
  );
}
