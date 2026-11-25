/**
 * Short spoken answers (docs/voice-mode.md, "Short answers"): a one- or
 * two-character final ("要", "好", "嗯") or one short word ("yes", "nope") is
 * what the mic's noise gates were built to drop, and also what he says when
 * an agent has just asked him something. Such a final is kept:
 *
 * - when the latest line in his thread is an agent's question (it ends in a
 *   question mark) or an ask card still waiting for a tap; or
 * - always, when it is one of the answer words (config stt.shortAnswerWords):
 *   yes/no words and the option code words agents offer ("苹果", "批准"…),
 *   alone or after a lane's name ("小克 苹果").
 *
 * Otherwise the gates stay as they were. One engine for every language: the
 * words are data, and a question is known by its mark, not by its grammar.
 * Pure, except for the page's live settings and thread (set by the page).
 */
import type { Ask, AskAnswer } from "./ask";
import { routeLine } from "./lane-route";

export type ShortAnswerLimits = {
  /** A final of at most this many characters (letters and digits, any script) is short. */
  maxChars: number;
  /** …and so is a single word of at most this many characters ("yes", "nope", "okay"). */
  maxWordChars: number;
  /**
   * The least Silero speech (frames at SPEECH_FRAME_PROB) a short answer needs.
   * The VAD calls anything under its minSpeechMs a misfire; one with at least
   * this much is still transcribed, and kept only when it is an answer.
   */
  minSpeechMs: number;
  /** Words that are an answer whatever comes before them (normalized when compared). */
  words: readonly string[];
};

/**
 * The defaults. 2 characters holds 要, 不要, 好的, 可以; 8 letters a Latin
 * "approve". 64 ms is two Silero frames: under it there is no syllable.
 */
export const SHORT_ANSWER: ShortAnswerLimits = {
  maxChars: 2,
  maxWordChars: 8,
  minSpeechMs: 64,
  words: [
    // Option code words agents offer ("小克 苹果": docs/voice-mode.md).
    "苹果",
    "香蕉",
    "橘子",
    "葡萄",
    "批准",
    "驳回",
    "搁置",
    // Yes/no and their kin, two characters or more: a lone 要, 好, 是 or 嗯 is
    // also what noise turns into, so a single character counts only while a
    // question waits (keepShortAnswer).
    "不要",
    "好的",
    "不是",
    "不对",
    "不行",
    "可以",
    "没错",
    "yes",
    "no",
    "yeah",
    "yep",
    "nope",
    "ok",
    "okay",
    "sure",
    "はい",
    "いいえ",
    "うん",
    "ううん",
    "네",
    "아니요",
    "oui",
    "non",
    "ja",
    "nein",
    "sí",
    "да",
    "нет",
  ],
};
export const SHORT_ANSWER_RANGE = {
  maxChars: { min: 0, max: 8 },
  maxWordChars: { min: 0, max: 24 },
  minSpeechMs: { min: 32, max: 2_000 },
} as const;

/** Letters, marks and digits only, NFKC, lower case: "Yes!" → "yes", "小克，苹果。" → "小克苹果". */
export const answerKey = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "");

const graphemes = (s: string) =>
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;

const wordCount = (s: string) =>
  [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(s)].filter((x) => x.isWordLike)
    .length;

/** What is left once a lane's name in front is taken off ("小克 苹果" → "苹果"). */
function body(text: string): string {
  const r = routeLine(text);
  return r.addressed ? r.text : text;
}

/** One of the answer words, alone or after a lane's name. */
export function isAnswerWord(text: string, l: ShortAnswerLimits = liveLimits): boolean {
  const k = answerKey(body(text));
  return !!k && l.words.some((w) => answerKey(w) === k);
}

/** A short final: at most maxChars characters, or one word of at most maxWordChars. */
export function isShortFinal(text: string, l: ShortAnswerLimits = liveLimits): boolean {
  const t = body(text);
  const k = answerKey(t);
  if (!k) return false;
  const n = graphemes(k);
  return n <= l.maxChars || (n <= l.maxWordChars && wordCount(t) === 1);
}

/** Keep this final although it is short: an answer word, or short while a question waits. */
export function keepShortAnswer(
  text: string,
  awaiting: boolean,
  l: ShortAnswerLimits = liveLimits,
): boolean {
  return isAnswerWord(text, l) || (awaiting && isShortFinal(text, l));
}

/** What awaitsAnswer reads of a chat line. */
export type AnswerLine = {
  from: string;
  text: string;
  removed?: true;
  ask?: Ask;
  answer?: AskAnswer;
  /** A system line about a lane (wire.ts): never a question. */
  laneEvent?: unknown;
};

/** A question's closing mark in any script: ? ？ ؟ (Arabic) ; (Greek, U+037E) ⸮ ՞ (Armenian) ፧ (Ethiopic). */
const QUESTION_END = /[?？؟\u037E⸮՞፧]["'”’」』）)\]\s]*$/u;

/**
 * Is a question waiting for his answer: the latest line (removed ones aside)
 * an agent's, ending in a question mark, or an ask card neither answered,
 * withdrawn nor expired?
 */
export function awaitsAnswer(lines: readonly AnswerLine[], now = Date.now()): boolean {
  const last = lines.findLast((m) => !m.removed && !m.laneEvent);
  if (!last || last.from !== "agent") return false;
  const a = last.ask;
  if (a && !last.answer && !a.withdrawnAt && !(a.expiresAt !== undefined && a.expiresAt <= now))
    return true;
  return QUESTION_END.test(last.text.trim());
}

const num = (v: unknown, r: { min: number; max: number }, d: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max ? v : d;

/** Valid limits from untrusted values: anything out of range or of the wrong kind reads as the default. */
export function shortAnswerLimitsOf(v: {
  maxChars?: unknown;
  maxWordChars?: unknown;
  minSpeechMs?: unknown;
  words?: unknown;
}): ShortAnswerLimits {
  const words =
    Array.isArray(v.words) && v.words.every((w) => typeof w === "string")
      ? (v.words as string[]).filter((w) => answerKey(w))
      : SHORT_ANSWER.words;
  return {
    maxChars: num(v.maxChars, SHORT_ANSWER_RANGE.maxChars, SHORT_ANSWER.maxChars),
    maxWordChars: num(v.maxWordChars, SHORT_ANSWER_RANGE.maxWordChars, SHORT_ANSWER.maxWordChars),
    minSpeechMs: num(v.minSpeechMs, SHORT_ANSWER_RANGE.minSpeechMs, SHORT_ANSWER.minSpeechMs),
    words,
  };
}

/** The live limits (config stt.shortAnswer*), set by the page; SHORT_ANSWER until then. */
let liveLimits: ShortAnswerLimits = SHORT_ANSWER;
export function setShortAnswerLimits(v: Parameters<typeof shortAnswerLimitsOf>[0]): void {
  liveLimits = shortAnswerLimitsOf(v);
}
export const shortAnswerLimits = (): ShortAnswerLimits => liveLimits;

/** The page's thread, for awaitsAnswer (the chat sets it); none until then. */
let thread: () => readonly AnswerLine[] = () => [];
export function setAnswerThread(f: () => readonly AnswerLine[]): () => void {
  thread = f;
  return () => {
    if (thread === f) thread = () => [];
  };
}
/** A question waits for his answer in the page's thread now. Never throws. */
export function awaitingAnswer(now = Date.now()): boolean {
  try {
    return awaitsAnswer(thread(), now);
  } catch {
    return false;
  }
}
