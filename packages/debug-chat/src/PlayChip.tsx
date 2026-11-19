"use client";
/**
 * The ▶ chip on a chat line that carries audio (`say --play`; play-audio.ts,
 * li-player.ts; docs/li-sound-hub.md, "Playing audio from an agent"): play or
 * pause, stop, and a progress bar for a file or a "live" badge for a stream.
 * When it did not start by itself, it says why in words (a tap plays it; the
 * mic is on; it waits for Li; it failed): never silence with no reason.
 * Colours in oklch; the seal-red accent is the theme's, never an error cue.
 */
import { useSyncExternalStore } from "react";
import { chatExtra } from "./chat-ui-locales";
import type { LineAudio } from "./play-audio";
import { type LiPlayer, type PlayView } from "./li-player";

const ACCENT = "oklch(0.55 0.19 27)";
const IDLE: PlayView = { id: null, status: "idle", pos: 0, dur: NaN, live: false };

/** The words under the chip for this view, or null. */
export function playNote(
  v: PlayView,
  x: Pick<
    ReturnType<typeof chatExtra>,
    "playTap" | "playMicOn" | "playWaiting" | "playFailed" | "playNoStream"
  >,
): string | null {
  if (v.status === "blocked") return `🔊 ${x.playTap}`;
  if (v.status === "waiting") return x.playWaiting;
  if (v.why === "mic") return x.playMicOn;
  if (v.status === "error") return v.why === "hls" || v.why === "unsupported" ? x.playNoStream : x.playFailed;
  return null;
}

const mmss = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return "";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

export function PlayChip({
  id,
  audio,
  player,
}: {
  id: string;
  audio: LineAudio;
  player: LiPlayer | null;
}) {
  const v = useSyncExternalStore(
    (f) => player?.subscribe(() => f()) ?? (() => {}),
    () => player?.view() ?? IDLE,
    () => player?.view() ?? IDLE,
  );
  const x = chatExtra();
  const mine = v.id === id ? v : IDLE;
  const playing = mine.status === "playing" || mine.status === "loading";
  const live = mine.id ? mine.live : audio.kind !== "file";
  const pct =
    !live && Number.isFinite(mine.dur) && mine.dur > 0 ? Math.min(100, (mine.pos / mine.dur) * 100) : 0;
  const note = playNote(mine, x);
  const name = audio.title ?? x.playAudio;
  const btn =
    "tap-40 inline-flex size-7 items-center justify-center rounded-full border border-current/25 fs-11";
  return (
    <span
      data-testid="debug-chat-play"
      data-play-status={mine.status}
      data-play-kind={audio.kind}
      className="mt-1 flex max-w-full flex-col gap-0.5"
    >
      <span className="inline-flex max-w-full items-center gap-1.5">
        <button
          type="button"
          data-testid="debug-chat-play-toggle"
          aria-label={playing ? x.playPause : x.playPlay}
          title={playing ? x.playPause : x.playPlay}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void player?.toggle(id, audio)}
          className={btn}
          style={{ color: ACCENT }}
        >
          {playing ? "⏸" : "▶"}
        </button>
        {mine.status !== "idle" && mine.status !== "ended" && (
          <button
            type="button"
            data-testid="debug-chat-play-stop"
            aria-label={x.playStop}
            title={x.playStop}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => player?.stop()}
            className={btn}
          >
            ⏹
          </button>
        )}
        <span className="min-w-0 truncate fs-11">{name}</span>
        {live ? (
          <span
            data-testid="debug-chat-play-live"
            className="shrink-0 rounded px-1 fs-10 font-semibold"
            style={{
              color: "oklch(0.98 0 0)",
              background: playing ? ACCENT : "oklch(0.6 0 0)",
            }}
          >
            ● {x.playLive}
          </span>
        ) : (
          <span className="flex min-w-16 flex-1 items-center gap-1">
            <span
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              data-testid="debug-chat-play-progress"
              className="h-1 flex-1 overflow-hidden rounded-full"
              style={{ background: "oklch(0.6 0 0 / 0.25)" }}
            >
              <span className="block h-full" style={{ width: `${pct}%`, background: ACCENT }} />
            </span>
            {mine.id && <span className="shrink-0 fs-10 text-gray-500">{mmss(mine.pos)}</span>}
          </span>
        )}
      </span>
      {note && (
        <button
          type="button"
          data-testid="debug-chat-play-note"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => mine.status === "blocked" && void player?.toggle(id, audio)}
          className="self-start text-start fs-10 text-gray-500"
        >
          {note}
        </button>
      )}
    </span>
  );
}
