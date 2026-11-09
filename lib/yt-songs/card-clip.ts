// A word's example sung in a YouTube song (docs/youtube-song-examples.md, M2):
// the clip of the song's line its example came from, kept on the word's list
// entry (word_list_entries.clip) and played in /words review (M3).
//
// The server works the clip out from the song's own stored timings
// (BookMeta.yt): a client never sends one. Client-safe: /words parses the
// stored JSON with `parseCardClip`.

import type { BookMeta } from "@/lib/read/book";

/** A line of a song: the video, and its start and end in ms (offset applied). */
export interface CardClip {
  v: string;
  t0: number;
  t1: number;
}

const ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_MS = 36_000_000;

/** A stored or served clip, checked; anything else is no clip. */
export function parseCardClip(v: unknown): CardClip | null {
  let o: unknown = v;
  if (typeof v === "string") {
    try {
      o = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const c = o as Partial<Record<keyof CardClip, unknown>>;
  if (typeof c.v !== "string" || !ID.test(c.v)) return null;
  const { t0, t1 } = c;
  if (!Number.isInteger(t0) || !Number.isInteger(t1)) return null;
  if ((t0 as number) < 0 || (t1 as number) <= (t0 as number) || (t1 as number) > MAX_MS)
    return null;
  return { v: c.v, t0: t0 as number, t1: t1 as number };
}

const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

/**
 * For a song (a book with `yt`): the clip of the line an example sentence came
 * from, as the JSON stored on the entry. The reader's example is a sentence of
 * one line, so the first line that holds it is its line. Not a song, an
 * example from no line, or clips that no longer match the lines: undefined /
 * null, and the entry is stored as ever.
 */
export function songClipFinder(
  meta: BookMeta | null | undefined,
  lines: readonly string[],
): ((ex: string) => string | null) | undefined {
  const yt = meta?.source === "youtube" ? meta.yt : undefined;
  if (!yt || yt.clips.length !== lines.length) return undefined;
  const normed = lines.map(norm);
  return (ex: string) => {
    const s = norm(ex);
    if (!s) return null;
    const i = normed.findIndex((l) => l.includes(s));
    const c = i >= 0 ? yt.clips[i] : undefined;
    if (!c) return null;
    const t0 = Math.max(0, c[0] + yt.offsetMs);
    const t1 = Math.max(t0 + 250, c[1] + yt.offsetMs);
    return JSON.stringify({ v: yt.v, t0, t1 } satisfies CardClip);
  };
}
