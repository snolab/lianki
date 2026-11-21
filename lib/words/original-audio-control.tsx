"use client";

import { useIntlayer } from "next-intlayer";
import type { NativeDownload } from "./native-audio-client";

export function NativeAudioProgress({ progress }: { progress?: NativeDownload }) {
  const text = useIntlayer("words-original-audio-controls");
  if (!progress || progress.phase === "idle") return null;
  const downloading = progress.phase === "downloading";
  const percent = progress.total
    ? Math.min(100, Math.floor((progress.loaded / progress.total) * 100))
    : undefined;
  const label = downloading ? text.downloading : text.preparing;
  return (
    <div className="min-w-36 text-xs" data-original-audio-progress>
      <div className="flex justify-between gap-2" role="status">
        <span>{label.value}</span>
        {downloading && percent !== undefined && <span aria-hidden="true">{percent}%</span>}
      </div>
      <progress
        className="h-1 w-full"
        max={100}
        value={downloading ? percent : undefined}
        aria-label={label.value}
      />
    </div>
  );
}

export function OriginalAudioControl({
  ready,
  available,
  progress,
  failed,
  onPlay,
}: {
  ready: boolean;
  available: boolean;
  progress?: NativeDownload;
  failed: boolean;
  onPlay(): void;
}) {
  const text = useIntlayer("words-original-audio-controls");
  return (
    <div className="border-b border-black/10 dark:border-white/10 py-3" data-original-audio-control>
      <button
        type="button"
        disabled={ready && !available}
        className="tap-40 w-full rounded-lg bg-black/10 dark:bg-white/10 px-3 py-2 text-left disabled:opacity-50"
        onClick={onPlay}
      >
        {text.play.value}
      </button>
      {!ready && !failed ? (
        <p className="mt-1 text-xs opacity-70">{text.preparing.value}</p>
      ) : ready && !available ? (
        <p className="mt-1 text-xs opacity-70">{text.missing.value}</p>
      ) : null}
      <NativeAudioProgress progress={progress} />
      {failed && (
        <p className="mt-1 text-xs" role="alert">
          {text.failed.value}
        </p>
      )}
    </div>
  );
}
