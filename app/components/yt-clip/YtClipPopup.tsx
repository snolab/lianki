"use client";

// One line of a YouTube song, played in YouTube's own embedded player inside
// a popup (docs/youtube-song-examples.md, "The popup player"):
//
// - one player per page, made on the first ▶ (the API script loads then) and
//   reused for every clip; destroyed when the page goes;
// - `loadVideoById({videoId, startSeconds, endSeconds})`: the API itself
//   stops at the end, no timer;
// - if it has not started ~1.2 s after the tap (iOS's first play: our tap
//   does not reach the cross-origin iframe), a hint asks for one tap on
//   YouTube's own ▶ inside the video, which is a real gesture;
// - the video stays visible (≥ 200 × 200), nothing covers its controls; no
//   hidden or background playback;
// - ×, Escape, a tap outside, the phone's back: pause and hide (kept for the
//   next clip). Nothing plays after close.
// - a sound on the page: it claims the page's audio at `card` rank
//   (audio-claim.ts), so it pauses the reader's read-aloud and yields to Li.

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useIntlayer } from "next-intlayer";
import { AUDIO_PRIO, audioOwner, audioOwnerId } from "@lianki/debug-chat/audio-claim";
import { useBackToClose } from "@/lib/use-back-to-close";
import { clipSeconds, type ClipMs } from "@/lib/yt-songs/timed-text";
import { loadYtApi, YT_HOST, YT_STATE, type YtPlayer } from "./yt-api";

export interface YtClip {
  /** The video id. */
  v: string;
  clip: ClipMs;
  offsetMs?: number;
  /** The line's text, shown above the video. */
  text?: string;
}

export interface YtClipHandle {
  /** Open the popup and play this clip; `anchor` places it near the tapped row on desktop. */
  play(c: YtClip, anchor?: HTMLElement | null): void;
  close(): void;
}

/** Wider than this: a card near the row; narrower: a sheet at the bottom. */
const DESK_MIN = 640;
const CARD_W = 480;
/** Not started this long after the tap: ask for a tap inside the video. */
const START_GRACE_MS = 1200;

type Place = { top: number; left: number } | null;

export function YtClipPopup({ ref }: { ref?: Ref<YtClipHandle> }) {
  const t = useIntlayer("yt-songs");
  const [open, setOpen] = useState(false);
  const [needTap, setNeedTap] = useState(false);
  const [place, setPlace] = useState<Place>(null);
  const [current, setCurrent] = useState<YtClip | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YtPlayer | null>(null);
  const ready = useRef<Promise<YtPlayer> | null>(null);
  const want = useRef<YtClip | null>(null);
  const seq = useRef(0);
  const audio = useRef<ReturnType<typeof audioOwner> | null>(null);

  const startClip = useCallback((p: YtPlayer, c: YtClip) => {
    const my = ++seq.current;
    let dur = 0;
    try {
      dur = p.getDuration() || 0;
    } catch {}
    p.loadVideoById({ videoId: c.v, ...clipSeconds(c.clip, c.offsetMs ?? 0, dur || undefined) });
    setNeedTap(false);
    window.setTimeout(() => {
      if (seq.current !== my || want.current !== c) return;
      const s = p.getPlayerState();
      if (s === YT_STATE.UNSTARTED || s === YT_STATE.CUED) setNeedTap(true);
    }, START_GRACE_MS);
  }, []);

  /** The page's one player, made on first use inside the popup's video area. */
  const getPlayer = useCallback((first: YtClip): Promise<YtPlayer> => {
    if (ready.current) return ready.current;
    ready.current = loadYtApi().then(
      (YT) =>
        new Promise<YtPlayer>((resolve) => {
          const el = document.createElement("div");
          host.current!.replaceChildren(el);
          // Made with the video only; the clip itself is loaded once it is ready.
          new YT.Player(el, {
            host: YT_HOST,
            videoId: first.v,
            width: "100%",
            height: "100%",
            playerVars: {
              playsinline: 1,
              controls: 1,
              rel: 0,
              origin: window.location.origin,
            },
            events: {
              onReady: (e) => {
                player.current = e.target;
                resolve(e.target);
              },
              onStateChange: (e) => {
                const own = audio.current;
                if (e.data === YT_STATE.PLAYING) {
                  setNeedTap(false);
                  // Li (or another higher sound) holds the page: wait for the next tap.
                  if (own && !own.claim()) e.target.pauseVideo();
                } else if (e.data === YT_STATE.ENDED || e.data === YT_STATE.PAUSED) {
                  own?.release();
                }
              },
            },
          });
        }),
    );
    ready.current.catch(() => {
      ready.current = null;
    });
    return ready.current;
  }, []);

  const play = useCallback(
    (c: YtClip, anchor?: HTMLElement | null) => {
      want.current = c;
      setCurrent(c);
      setOpen(true);
      if (anchor && window.innerWidth >= DESK_MIN) {
        const r = anchor.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const h = (CARD_W * 9) / 16 + 72;
        const left = Math.min(Math.max(16, r.left), vw - CARD_W - 16);
        const below = r.bottom + 8;
        const top = below + h <= vh - 16 ? below : Math.max(16, r.top - h - 8);
        setPlace({ top, left });
      } else setPlace(null);
      setNeedTap(false);
      if (player.current) startClip(player.current, c);
      else
        void getPlayer(c)
          .then((p) => {
            if (want.current === c) startClip(p, c);
          })
          .catch((err) => console.error("yt-clip: player failed", String(err).slice(0, 200)));
    },
    [getPlayer, startClip],
  );

  const close = useCallback(() => {
    want.current = null;
    seq.current++;
    try {
      player.current?.pauseVideo();
    } catch {}
    audio.current?.release();
    setNeedTap(false);
    setOpen(false);
  }, []);

  useImperativeHandle(ref, () => ({ play, close }), [play, close]);

  // The page's audio claim; the player goes with the page.
  useEffect(() => {
    const own = audioOwner({
      id: audioOwnerId("yt-clip"),
      prio: AUDIO_PRIO.card,
      onYield: () => {
        try {
          player.current?.pauseVideo();
        } catch {}
      },
    });
    audio.current = own;
    return () => {
      own.dispose();
      audio.current = null;
      try {
        player.current?.destroy();
      } catch {}
      player.current = null;
      ready.current = null;
    };
  }, []);

  useBackToClose(open, close);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  const replay = () => {
    const c = current;
    if (c) play(c);
  };

  return (
    <div hidden={!open} data-testid="yt-clip-popup">
      {/* A tap outside closes: the backdrop is clear, the page stays in view. */}
      <div
        className="fixed inset-0 z-[60]"
        aria-hidden
        onClick={close}
        data-testid="yt-clip-backdrop"
      />
      <div
        role="dialog"
        aria-label={t.entry.value}
        className={
          place
            ? "lk-glass fixed z-[61] rounded-2xl border border-[var(--glass-line)] p-3 shadow-xl"
            : "lk-glass fixed inset-x-0 bottom-0 z-[61] rounded-t-2xl border-t border-[var(--glass-line)] px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl"
        }
        style={place ? { top: place.top, left: place.left, width: CARD_W } : undefined}
      >
        <div className="mb-2 flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm" dir="auto">
            {current?.text ?? ""}
          </p>
          <button
            type="button"
            onClick={replay}
            data-testid="yt-clip-replay"
            className="shrink-0 rounded-full px-3 py-1.5 text-sm font-medium text-[oklch(0.45_0.16_255)] hover:bg-[oklch(0.5_0.1_255/0.12)] dark:text-[oklch(0.8_0.12_255)]"
          >
            ↻ {t.replay}
          </button>
          <button
            type="button"
            onClick={close}
            aria-label={t.close.value}
            data-testid="yt-clip-close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg hover:bg-[oklch(0.5_0_0/0.12)]"
          >
            ×
          </button>
        </div>
        {/* YouTube's terms: the player stays visible, at least 200 × 200. */}
        <div
          ref={host}
          className="aspect-video min-h-[200px] w-full overflow-hidden rounded-lg bg-black [&>iframe]:h-full [&>iframe]:w-full"
        />
        {needTap && (
          <p className="mt-2 text-sm" data-testid="yt-clip-tap">
            {t.tapToStart}
          </p>
        )}
      </div>
    </div>
  );
}
