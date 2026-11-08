"use client";

// A YouTube song in the reader (docs/youtube-song-examples.md, M1): each sung
// line's ▶, and the page's one popup player. Off (no song, or the flag off
// for this viewer): no ▶ and no popup, nothing loaded.

import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { useIntlayer } from "next-intlayer";
import type { BookMeta } from "@/lib/read/book";
import { ClipButton } from "./ClipButton";
import { YtClipPopup, type YtClipHandle } from "./YtClipPopup";

export function useSongClips(
  book: BookMeta | undefined,
  lines: readonly string[],
  on: boolean,
): { clipOf?: (line: number) => ReactNode; popup: ReactNode } {
  const t = useIntlayer("yt-songs");
  const popup = useRef<YtClipHandle>(null);
  const yt = on && book?.source === "youtube" ? book.yt : undefined;
  // A clip per line, or none at all: a song whose lines no longer match its clips plays nothing.
  const clips = yt && yt.clips.length === lines.length ? yt : undefined;
  const label = t.playLine.value;

  const clipOf = useCallback(
    (line: number): ReactNode => {
      const c = clips?.clips[line];
      if (!clips || !c) return null;
      return (
        <ClipButton
          label={label}
          onPlay={(el) =>
            popup.current?.play(
              { v: clips.v, clip: c, offsetMs: clips.offsetMs, text: lines[line] },
              el,
            )
          }
        />
      );
    },
    [clips, label, lines],
  );

  return useMemo(
    () =>
      clips ? { clipOf, popup: <YtClipPopup ref={popup} /> } : { clipOf: undefined, popup: null },
    [clips, clipOf],
  );
}
