// The /read player (app/(app)/reader/[id]/ReaderV2.tsx) as a pure state
// machine, so its rules are tested without a browser (unit/read-player.test.ts).
//
// Play reads the current line aloud. What happens when the line's audio has
// really ended depends on the mode:
//
// - **wait** (default): the player waits for the reader — "your turn". He
//   moves on by grading the paragraph (a swipe) or by tapping another one.
// - **auto** (`lk:pref:read-auto`, per device): it reads on, line after line.
//
// Headings are read and then always read on (there is nothing to practise in
// "Chapter 3"); blank lines are skipped without being spoken. Every utterance
// carries a token: an end or error event of an older one is ignored, so a
// late `onend` can never advance twice. A failure stops playback with its
// message instead of racing ahead.

import { primaryLang } from "./lang-detect";

export type PlayerStatus = "idle" | "speaking" | "waiting" | "ended" | "error";

export type PlayerState = {
  status: PlayerStatus;
  line: number;
  /** Bumped by every new utterance; the speech effect keys on it. */
  token: number;
  error?: string;
};

export type PlayerEvent =
  | { type: "play" }
  | { type: "stop" }
  | { type: "next" }
  | { type: "replay" }
  | { type: "select"; line: number }
  | { type: "ended"; token: number }
  | { type: "failed"; token: number; error: string };

export type PlayerCfg = {
  total: number;
  auto: boolean;
  /** Spoken, then read on even in wait mode. */
  isHeading(i: number): boolean;
  /** Not spoken at all (blank). */
  isBlank(i: number): boolean;
};

export const initialPlayer = (line = 0): PlayerState => ({ status: "idle", line, token: 0 });

/** The first line at or after `from` that is spoken (-1: none left). */
export function speakableFrom(from: number, cfg: PlayerCfg): number {
  for (let i = Math.max(0, from); i < cfg.total; i++) if (!cfg.isBlank(i)) return i;
  return -1;
}

const clamp = (n: number, total: number) => Math.min(Math.max(0, n), Math.max(0, total - 1));

/** Speak line `at` (or the next spoken one after it); past the end: ended. */
function speak(s: PlayerState, at: number, cfg: PlayerCfg): PlayerState {
  const i = speakableFrom(at, cfg);
  if (i < 0) return { status: "ended", line: clamp(at, cfg.total), token: s.token };
  return { status: "speaking", line: i, token: s.token + 1 };
}

export function playerReducer(s: PlayerState, e: PlayerEvent, cfg: PlayerCfg): PlayerState {
  if (cfg.total <= 0) return s;
  switch (e.type) {
    case "play":
      if (s.status === "speaking") return s;
      // From the end, Play starts the book over; otherwise from the current line.
      return speak(s, s.status === "ended" ? 0 : s.line, cfg);
    case "stop":
      return s.status === "speaking" || s.status === "waiting" || s.status === "error"
        ? { status: "idle", line: s.line, token: s.token }
        : s;
    case "replay":
      return speak(s, s.line, cfg);
    case "next":
      // Idle: just the cursor. Playing or waiting: read the next line.
      if (s.status === "idle" || s.status === "ended" || s.status === "error")
        return { status: "idle", line: clamp(s.line + 1, cfg.total), token: s.token };
      return speak(s, s.line + 1, cfg);
    case "select": {
      const line = clamp(e.line, cfg.total);
      if (s.status === "speaking" || s.status === "waiting") return speak(s, line, cfg);
      return { status: "idle", line, token: s.token };
    }
    case "ended":
      if (s.status !== "speaking" || e.token !== s.token) return s;
      if (cfg.auto || cfg.isHeading(s.line)) return speak(s, s.line + 1, cfg);
      return { status: "waiting", line: s.line, token: s.token };
    case "failed":
      if (s.status !== "speaking" || e.token !== s.token) return s;
      return { status: "error", line: s.line, token: s.token, error: e.error };
  }
}

/** The line in utterances of at most `max` chars: sentence ends first, then clauses, then spaces. */
export function speechChunks(text: string, max = 200): string[] {
  const out: string[] = [];
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?。！？…][»"'”’)\]]*)\s+|(?<=[。！？])/u)
    .filter((p) => p.trim());
  for (let p of parts) {
    p = p.trim();
    while (p.length > max) {
      const head = p.slice(0, max);
      let cut = Math.max(...[",", ";", ":", "，", "、", "；"].map((c) => head.lastIndexOf(c)));
      if (cut < max / 3) cut = head.lastIndexOf(" ");
      cut = cut < max / 3 ? max : cut + 1;
      out.push(p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    if (p) out.push(p);
  }
  return out;
}

/**
 * A material's language: the book's, else the heaviest language of the
 * sample (lib/read/lang-detect.ts: scripts and function words, as data);
 * text that names none reads as English.
 */
export function readLang(bookLang: string | undefined, sample: string): string {
  if (bookLang) return bookLang.replace(/_/g, "-");
  const l = primaryLang([sample]);
  return l && l !== "und" ? l : "en";
}
