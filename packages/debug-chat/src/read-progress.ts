/**
 * Which sentences of the agent's lines have been read aloud: spoken (grey),
 * speaking (highlighted), or not yet (normal). Client-only.
 *
 * The voice session (voice.ts) is shared on the page and may be an older
 * copy than this widget, so this follows it only through what every copy
 * has: its state's `queued` count (sentences left, the current one
 * included) and `onStart` (a sentence began playing). A mirror of the
 * queue, one entry per sentence, is kept here:
 *
 * - a reply queued (the count grows by its sentence count) appends its
 *   sentences (`enqueue`, matched to the message by the widget);
 * - a sentence starting marks the head as speaking;
 * - the count shrinking marks that many head sentences spoken; a pause
 *   keeps the count (the head restarts later: it stays the head);
 * - the count dropping to 0 with sentences left ("Stop reading") drops
 *   them: they stay unspoken.
 */
import { chunk, sentences } from "./voice";

export type ReadEntry = { id: string; idx: number };
export type ReadProgress = {
  queue: readonly ReadEntry[];
  /** Per message id: how many of its sentences were spoken (from its first). */
  done: Readonly<Record<string, number>>;
  /** The sentence playing now, if any. */
  speaking: ReadEntry | null;
  /** The session's last `queued`. */
  queued: number;
  /** Sentences the session queued that no message has claimed yet. */
  unmatched: number;
};
export type ReadEvent =
  | { type: "queued"; n: number }
  | { type: "start" }
  | { type: "enqueue"; id: string; n: number };

export const initialRead = (done: Record<string, number> = {}): ReadProgress => ({
  queue: [],
  done,
  speaking: null,
  queued: 0,
  unmatched: 0,
});

/** At most this many messages keep their spoken count (the oldest go first). */
export const READ_KEEP = 200;

const markDone = (done: Readonly<Record<string, number>>, gone: readonly ReadEntry[]) => {
  if (!gone.length) return done;
  const next: Record<string, number> = { ...done };
  for (const e of gone) next[e.id] = Math.max(next[e.id] ?? 0, e.idx + 1);
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - READ_KEEP))) delete next[id];
  return next;
};

export function readStep(p: ReadProgress, ev: ReadEvent): ReadProgress {
  switch (ev.type) {
    case "queued": {
      const n = Math.max(0, ev.n);
      if (n === p.queued) return p;
      if (n > p.queued) return { ...p, queued: n, unmatched: p.unmatched + (n - p.queued) };
      // Finished sentences go one at a time; more at once is "Stop reading"
      // (the queue cleared): what was left was never heard.
      if (p.queued - n > 1) return { ...p, queue: [], speaking: null, queued: n, unmatched: 0 };
      const k = Math.min(p.queued - n, p.queue.length);
      const gone = p.queue.slice(0, k);
      const left = p.queue.slice(k);
      const stillSpeaking =
        p.speaking && left.some((e) => e.id === p.speaking!.id && e.idx === p.speaking!.idx);
      return {
        ...p,
        queue: left,
        done: markDone(p.done, gone),
        speaking: stillSpeaking ? p.speaking : null,
        queued: n,
        unmatched: Math.max(0, p.unmatched - (p.queued - n - k)),
      };
    }
    case "start":
      return p.queue[0] ? { ...p, speaking: p.queue[0] } : p;
    case "enqueue": {
      if (ev.n <= 0) return p;
      const add = Array.from({ length: ev.n }, (_, idx) => ({ id: ev.id, idx }));
      return {
        ...p,
        queue: [...p.queue, ...add],
        unmatched: Math.max(0, p.unmatched - ev.n),
      };
    }
  }
}

/** A message's sentences as the voice reads them (voice.ts sentences, then chunk). */
export const sentenceCount = (text: string) => sentences(text).flatMap((s) => chunk(s)).length;

/**
 * The text cut where the voice cuts it, as ranges of the original string
 * (so the rendered text is unchanged: the gaps between sentences, newlines
 * included, belong to the sentence before). A sentence not found in order
 * (the voice normalised it) ends the split: the rest is one range.
 */
export function sentenceRanges(text: string): { start: number; end: number }[] {
  const parts = sentences(text).flatMap((s) => chunk(s));
  const out: { start: number; end: number }[] = [];
  let at = 0;
  for (const part of parts) {
    const i = text.indexOf(part, at);
    if (i < 0) break;
    if (out.length) out[out.length - 1]!.end = i;
    out.push({ start: out.length ? i : 0, end: i + part.length });
    at = i + part.length;
  }
  if (!out.length) return text ? [{ start: 0, end: text.length }] : [];
  out[out.length - 1]!.end = text.length;
  return out;
}

/** One sentence's look: spoken, speaking, or not yet read. */
export function sentenceState(
  p: Pick<ReadProgress, "done" | "speaking">,
  id: string,
  idx: number,
): "spoken" | "speaking" | "unread" {
  if (p.speaking && p.speaking.id === id && p.speaking.idx === idx) return "speaking";
  return idx < (p.done[id] ?? 0) ? "spoken" : "unread";
}
