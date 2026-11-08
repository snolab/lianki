"use client";

// A YouTube song in the reader (docs/youtube-song-examples.md, M1): each sung
// line's ▶, played in the page's one popup player (YtClipProvider, mounted by
// ReaderV2 when songs are on for this viewer). No provider, or not a song: no ▶.

import { useCallback, type ReactNode } from "react";
import { useIntlayer } from "next-intlayer";
import type { BookMeta } from "@/lib/read/book";
import { ClipButton } from "./ClipButton";
import { useClipPlayer } from "./clip-context";

export function useSongClips(
  book: BookMeta | undefined,
  lines: readonly string[],
): { clipOf?: (line: number) => ReactNode } {
  const t = useIntlayer("yt-songs");
  const player = useClipPlayer();
  const yt = player && book?.source === "youtube" ? book.yt : undefined;
  // A clip per line, or none at all: a song whose lines no longer match its clips plays nothing.
  const clips = yt && yt.clips.length === lines.length ? yt : undefined;
  const label = t.playLine.value;

  const clipOf = useCallback(
    (line: number): ReactNode => {
      const c = clips?.clips[line];
      if (!clips || !c || !player) return null;
      return (
        <ClipButton
          label={label}
          onPlay={(el) =>
            player.play({ v: clips.v, clip: c, offsetMs: clips.offsetMs, text: lines[line] }, el)
          }
        />
      );
    },
    [clips, label, lines, player],
  );

  return { clipOf: clips ? clipOf : undefined };
}
