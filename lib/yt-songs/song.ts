// A YouTube song as a /read book (docs/youtube-song-examples.md): one passage
// per sung line, each with its clip in BookMeta.yt. Pure: the route saves it.

import type { ParsedBook, YtSongMeta } from "@/lib/read/book";
import type { TimedLine } from "./timed-text";

/** The book and its clips; `lines[i]` plays `yt.clips[i]`. */
export function songBook(
  videoId: string,
  title: string,
  timed: readonly TimedLine[],
  offsetMs = 0,
): { book: ParsedBook; yt: YtSongMeta } {
  return {
    book: {
      title,
      lines: timed.map((l) => l.text),
      chapters: [],
      headings: [],
    },
    yt: {
      v: videoId,
      offsetMs,
      clips: timed.map((l) => [Math.round(l.t0), Math.round(l.t1)] as [number, number]),
    },
  };
}

/** The read_materials.source_key of a song: one book per video per user. */
export const songSourceKey = (videoId: string) => `youtube:${videoId}`;
