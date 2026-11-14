/**
 * The live speech line (owner, 2026-11-14 04:25 JST): while he speaks, the
 * words being recognised are not a draft in the input box but the newest line
 * of the chat log, with his avatar, growing as he speaks — not sent yet, not
 * stored, not read aloud, never a ChatMessage. Pure rules here; DebugChat
 * draws it.
 *
 * Where spoken text goes:
 * - The draft is still exactly the mic's (wire.ts draftSource: `pureDictation`)
 *   or empty: the draft and the dimmed interim tail are the bubble, and the
 *   input shows nothing (free for typing).
 * - He starts typing (a key, a paste, an IME composition) or taps the bubble:
 *   the spoken text moves into the input (`inInput`), editable, and from then
 *   on it is an ordinary draft — the same semantics as before: sent unchanged it
 *   is still `source: "stt"`, edited it is a typed line.
 * - The draft has typed text in it: everything stays in the input, the interim
 *   tail mirrored dimmed after it, as before.
 *
 * A spoken line that went out stays as a "sending" bubble until its echo
 * arrives (an owner line not there at the send, or the line it amends, that
 * contains its text), or HOLD_MS at most, so it never blinks out before the
 * real line appears, and never shows twice: the echo removes it in the same
 * render.
 */
import { joinText } from "./mic";
import type { ChatMessage } from "./wire";

/** A sent spoken line is shown as "sending" at most this long, waiting for its echo. */
export const HOLD_MS = 6000;

/** The id of the provisional line: never a hub id (those are 12 hex characters). */
export const LIVE_ID = "lk-live-speech";

/** The draft is exactly what the mic left there (and has words). */
export function spokenPending(draft: string, pure: string | null): boolean {
  return pure !== null && draft === pure && !!draft.trim();
}

export type LiveSpeechIn = {
  draft: string;
  pureDictation: string | null;
  /** The dimmed interim text (partials, or "…" for transcripts still out). */
  interim: string;
  /** He took the spoken text into the input to edit it. */
  inInput: boolean;
};

export type LiveSpeech = {
  /** The bubble's settled words (the spoken draft) and its dimmed tail; null: no bubble. */
  bubble: { text: string; tail: string } | null;
  /** What the input box shows. */
  input: string;
};

/** Where the spoken words show: the bubble, or (typed text in the draft) the input. */
export function liveSpeech({ draft, pureDictation, interim, inInput }: LiveSpeechIn): LiveSpeech {
  const inBubble = !inInput && (draft === "" || spokenPending(draft, pureDictation));
  if (!inBubble) return { bubble: null, input: draft };
  const tail = joinText(draft, interim).slice(draft.length);
  return {
    bubble: draft || tail.trim() ? { text: draft, tail } : null,
    input: "",
  };
}

/** A spoken line sent from the bubble, shown until its echo. */
export type SentHold = {
  key: number;
  text: string;
  at: number;
  /** The owner lines already in the log at the send. */
  seen: readonly string[];
  /** The line it asked to amend (voice-merge.ts). */
  continues?: string;
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The hub's echo of a held line is in the log. */
export function echoed(messages: readonly ChatMessage[], h: SentHold): boolean {
  const want = norm(h.text);
  return messages.some(
    (m) =>
      m.from !== "agent" &&
      (!h.seen.includes(m.id) || m.id === h.continues) &&
      norm(m.text).includes(want),
  );
}

/** The held lines still shown: not echoed, and not past HOLD_MS. */
export function liveHolds(
  holds: readonly SentHold[],
  messages: readonly ChatMessage[],
  now: number,
): SentHold[] {
  return holds.filter((h) => now - h.at < HOLD_MS && !echoed(messages, h));
}

/** A line about to be held: the owner lines there now. */
export function holdOf(
  key: number,
  text: string,
  messages: readonly ChatMessage[],
  now: number,
  continues?: string,
): SentHold {
  return {
    key,
    text,
    at: now,
    seen: messages.filter((m) => m.from !== "agent").map((m) => m.id),
    ...(continues ? { continues } : {}),
  };
}

/** A key that takes the spoken text into the input (typing starts); not navigation or send. */
export function takesSpoken(key: string, mods: { ctrl?: boolean; meta?: boolean } = {}): boolean {
  if (mods.ctrl || mods.meta) return false;
  if (key === "Backspace" || key === "Delete" || key === "Unidentified" || key === "Process") return true;
  return [...key].length === 1;
}
