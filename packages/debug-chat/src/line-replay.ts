/**
 * "Play original audio" in a chat line's details (MessageDetails.tsx;
 * docs/recordings.md, "Replay from the chat"): finds the account's own
 * recording of one of his spoken lines and turns it into line audio for Li's
 * player (li-player.ts), so it plays under the same rules as any line audio —
 * never over his open mic, paused while Li speaks.
 *
 * No server link is stored. The mic (mic.ts) stamps a recorded utterance's
 * `at` between the two times it reports on the line: `t_speechEnd` (the VAD
 * ended it) ≤ `at` ≤ `t_uploadStart` (just after the clip was cut), both on
 * the same device clock. So the clip of a line part is the one recording whose
 * `at` lies in that window, found with the feed (`GET ?before=&limit=`), own
 * rows only. A merged line looks up each part. No window, or no clip in it:
 * nothing is shown.
 */
import type { LineAudio } from "./play-audio";
import { RECORDINGS_URL } from "./recorder";
import type { ChatMessage, VoiceTiming } from "./wire";

/** Clips asked for per window: the newest few before its end. */
export const REPLAY_LOOKUP_LIMIT = 5;

export type ReplayWindow = { from: number; to: number };

/** A recording as the feed lists it (only what is used here). */
type FeedClip = { id?: unknown; at?: unknown };

/** One of his own spoken lines (the mic's): the only lines with a recording. */
export function replayable(m: Pick<ChatMessage, "from" | "source" | "removed">): boolean {
  return m.from === "owner" && m.source === "stt" && !m.removed;
}

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Where one utterance's clip `at` must be, from its timing; null without one. */
export function windowOf(t: VoiceTiming | undefined): ReplayWindow | null {
  if (!t || !fin(t.t_speechEnd)) return null;
  const to = fin(t.t_uploadStart) ? t.t_uploadStart : undefined;
  if (to === undefined || to < t.t_speechEnd) return null;
  return { from: t.t_speechEnd, to };
}

/** The windows of a line: one per merged part, else the line's own; oldest first. */
export function replayWindows(m: Pick<ChatMessage, "timing" | "parts">): ReplayWindow[] {
  const timings = m.parts?.length ? m.parts.map((p) => p.timing) : [m.timing];
  return timings.map(windowOf).filter((w): w is ReplayWindow => w !== null);
}

/**
 * The clip ids for a line, oldest first, or null when recordings are off for
 * this account (the route's 404/401/403: flag or grant missing) — the caller
 * shows nothing either way. A window that finds nothing is skipped.
 */
export async function findLineClips(
  m: Pick<ChatMessage, "from" | "source" | "removed" | "timing" | "parts">,
  f: typeof fetch,
): Promise<string[] | null> {
  if (!replayable(m)) return [];
  const ids: string[] = [];
  for (const w of replayWindows(m)) {
    let r: Response;
    try {
      r = await f(`${RECORDINGS_URL}?before=${w.to + 1}&limit=${REPLAY_LOOKUP_LIMIT}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
    } catch {
      continue;
    }
    if (r.status === 404 || r.status === 401 || r.status === 403) return null;
    if (!r.ok) continue;
    const j = (await r.json().catch(() => null)) as { clips?: FeedClip[] } | null;
    const hit = (j?.clips ?? []).find(
      (c) => typeof c.id === "string" && fin(c.at) && c.at >= w.from && c.at <= w.to,
    );
    if (hit && !ids.includes(hit.id as string)) ids.push(hit.id as string);
  }
  return ids;
}

/** A clip as line audio for Li's player: the account's own WAV, read with his session. */
export function clipLineAudio(id: string, title: string, origin?: string): LineAudio {
  const path = `${RECORDINGS_URL}?clip=${encodeURIComponent(id)}`;
  return { src: origin ? new URL(path, origin).href : path, kind: "file", mime: "audio/wav", title };
}

/** The chip's title: the words, numbered when the line has several clips. */
export function replayTitle(words: string, i: number, n: number): string {
  return n > 1 ? `${words} ${i + 1}/${n}` : words;
}
