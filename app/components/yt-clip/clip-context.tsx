"use client";

// A word's example sung in a YouTube song, in review (docs/youtube-song-examples.md,
// M3): /words and the reader's word review show a ▶ beside an example that has a
// clip (word_list_entries.clip), which plays that line in the page's one popup
// player (YtClipPopup). The provider is mounted only where YouTube songs are on
// for this viewer; without it no ▶ shows and no player loads.

import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import { useIntlayer } from "next-intlayer";
import { parseCardClip } from "@/lib/yt-songs/card-clip";
import { ClipButton } from "./ClipButton";
import { YtClipPopup, type YtClip, type YtClipHandle } from "./YtClipPopup";

type ClipPlayer = { play(c: YtClip, anchor?: HTMLElement | null): void; close(): void };

const Ctx = createContext<ClipPlayer | null>(null);

/** The page's clip player for the review below it; `on` false renders the children alone. */
export function YtClipProvider({ on, children }: { on: boolean; children: ReactNode }) {
  const ref = useRef<YtClipHandle>(null);
  const play = useCallback(
    (c: YtClip, anchor?: HTMLElement | null) => ref.current?.play(c, anchor),
    [],
  );
  const close = useCallback(() => ref.current?.close(), []);
  const value = useMemo(() => ({ play, close }), [play, close]);
  if (!on) return <>{children}</>;
  return (
    <Ctx.Provider value={value}>
      {children}
      <YtClipPopup ref={ref} />
    </Ctx.Provider>
  );
}

/** The provider's player, or null where songs are off. */
export const useClipPlayer = () => useContext(Ctx);

/** The ▶ of an example with a song clip; nothing without one, or where songs are off. */
export function SongClipButton({ clip, text }: { clip?: string | null; text?: string }) {
  const player = useClipPlayer();
  const t = useIntlayer("yt-songs");
  const c = useMemo(() => (clip ? parseCardClip(clip) : null), [clip]);
  if (!player || !c) return null;
  return (
    <ClipButton
      label={t.playLine.value}
      onPlay={(el) => player.play({ v: c.v, clip: [c.t0, c.t1], text }, el)}
    />
  );
}
