/**
 * Two mics, one sentence (owner, 2026-11-14 02:15 JST: the mic open on his
 * Windows PC and his Mac at once, each with its own local STT and voiceprint,
 * so every sentence reached the chat twice, a second or two apart, with
 * near-identical text). Flag `stt.two-mic-merge`; the window is config
 * `chat.twoMicWindowMs`. docs/dev-debug-widget.md, "Two mics, one line".
 *
 * The hub asks `twoMicMatch` before it posts one of his voice lines: a voice
 * line from ANOTHER page, received within the window, whose text is the same
 * sentence, is the same utterance. Then `twoMicKeep` says which text stands.
 * Nothing here knows a language: the text is compared as characters, with
 * punctuation and spaces dropped.
 *
 * Pure, and free of the DOM: the Worker imports it.
 */
import { type ChatMessage, type SpeakerTag } from "./wire";

/** The `by` on the edit mark when the other mic's better text replaced a line. */
export const TWO_MIC_BY = "two-mic";
/** The default window (ms) between the two copies; the live value is config `chat.twoMicWindowMs`. */
export const TWO_MIC_WINDOW_MS = 4000;
/** The widest window the config takes (its max): the hub's cheap first look uses it. */
export const TWO_MIC_WINDOW_MAX = 30_000;
/** Similarity (0..1) at which two texts are the same sentence heard twice. */
export const TWO_MIC_SIMILARITY = 0.8;
/** One text inside the other counts only when it is at least this share of it (a clipped start). */
export const TWO_MIC_CONTAINED = 0.5;
/** Past this many characters the edit distance is not worth it: bigram Dice instead. */
const EDIT_DISTANCE_MAX = 600;

/** Letters and digits only, lower case: "同时发送着，两个麦克风。" → "同时发送着两个麦克风". */
export function normalizeSpoken(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Levenshtein distance between two strings (by UTF-16 unit; both short). */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Character-bigram Dice coefficient (0..1). */
function dice(a: string, b: string): number {
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let both = 0;
  for (const [g, n] of ga) both += Math.min(n, gb.get(g) ?? 0);
  return (2 * both) / (a.length - 1 + (b.length - 1));
}

/**
 * Are these two texts the same sentence, heard by two mics? Normalized, they
 * are near-identical (one character swapped in ten still is), or one holds
 * the other and is at most twice as long (a start clipped by a few characters).
 */
export function sameSentence(a: string, b: string): boolean {
  const x = normalizeSpoken(a);
  const y = normalizeSpoken(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.includes(short)) return short.length >= long.length * TWO_MIC_CONTAINED;
  if (short.length < 2) return false;
  const sim =
    long.length > EDIT_DISTANCE_MAX
      ? dice(short, long)
      : 1 - editDistance(short, long) / long.length;
  return sim >= TWO_MIC_SIMILARITY;
}

/** Whose voice the Mac said it was: "me", "other", or none (unknown, unsigned). */
const verdict = (s: SpeakerTag | undefined) =>
  s?.decision === "me" ? "me" : s?.decision === "other" ? "other" : undefined;

/** The incoming voice line, as the hub has it before posting. */
export type TwoMicCandidate = { text: string; label: string; at: number; speaker?: SpeakerTag };

/**
 * The stored line this incoming voice line repeats, from the owner thread's
 * kept lines (newest first): his own voice line from another page, within
 * `windowMs` of its latest words, saying the same sentence. A line the Mac
 * said is someone else's never pairs with one it said is his, nor the other
 * way round. Undefined: post it as its own line.
 */
export function twoMicMatch<K>(
  kept: readonly (readonly [K, ChatMessage])[],
  cur: TwoMicCandidate,
  windowMs: number,
): readonly [K, ChatMessage] | undefined {
  if (windowMs <= 0) return undefined;
  for (const entry of kept) {
    const x = entry[1];
    const at = x.parts?.at(-1)?.at ?? x.at;
    // Newest first: past the window, every older line is too.
    if (cur.at - at > windowMs) return undefined;
    if (x.from !== "owner" || x.source !== "stt" || x.collapsedInto || x.summary || x.passage)
      continue;
    if (x.label === cur.label) continue;
    const a = verdict(x.speaker);
    const b = verdict(cur.speaker);
    if ((a === "other" || b === "other") && a !== b) continue;
    const texts = [x.text, ...(x.parts?.map((p) => p.text) ?? [])];
    if (texts.some((t) => sameSentence(t, cur.text))) return entry;
  }
  return undefined;
}

/**
 * Which text stands, once the two are one utterance: "replace" = the new
 * line's text takes the stored line's place; "drop" = the stored line stays
 * as it is. The voiceprint first (a line verified as him beats one that is
 * not), then the higher score, then the longer text. A line that is already
 * more than one utterance, or that an agent polished, is never replaced.
 */
export function twoMicKeep(stored: ChatMessage, cur: TwoMicCandidate): "replace" | "drop" {
  if (stored.parts || (stored.edited?.count ?? 0) > 0) return "drop";
  const a = verdict(stored.speaker);
  const b = verdict(cur.speaker);
  if (a !== b) return b === "me" ? "replace" : "drop";
  const sa = stored.speaker?.score;
  const sb = cur.speaker?.score;
  if (sa !== undefined && sb !== undefined && sa !== sb) return sb > sa ? "replace" : "drop";
  return normalizeSpoken(cur.text).length > normalizeSpoken(stored.text).length
    ? "replace"
    : "drop";
}
