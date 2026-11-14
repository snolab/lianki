/**
 * Echoes in the owner's voice lines (owner, 2026-11-14 20:2x JST: two phones
 * with their mics open in one room). Two kinds of copy still landed as his
 * own lines after the two-mic merge:
 *
 * - "other-device": the same sentence from his other phone, later than the
 *   two-mic window or transcribed a little differently;
 * - "read-aloud": Li reading a line aloud (an agent's reply, or his own
 *   polished line read back) heard by the other phone and transcribed back as
 *   if he had said it.
 *
 * The hub (workers/push/src/debug.ts, "Echoes") asks `echoMatch` before it
 * posts one of his voice lines; a hit is kept aside for undo, never shown,
 * read back or sent to the lanes. docs/dev-debug-widget.md, "Echoes".
 *
 * Nothing here knows a language: texts are compared as characters, with
 * punctuation, spaces and case dropped. Pure: the Worker imports it.
 */

/** Defaults; the live values are config voice.echo* (lib/config.ts). */
export const ECHO_WINDOW_MS = 8000;
export const ECHO_READ_WINDOW_MS = 60_000;
export const ECHO_SIMILARITY = 0.8;
export const ECHO_MIN_CHARS = 4;
/** The widest windows the config takes (their max): the hub's cheap first look uses them. */
export const ECHO_WINDOW_MAX = 60_000;
export const ECHO_READ_WINDOW_MAX = 300_000;
/** Past these lengths the edit distance is not worth it (an echo is one sentence). */
const NEEDLE_MAX = 600;
const HAY_MAX = 4000;

/** Letters and digits only, lower case: "表里 alive，只表示进程活着。" → "表里alive只表示进程活着". */
export function normalizeEcho(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Levenshtein distance; `free` = the needle may start and end anywhere in `b` (semi-global). */
function distance(a: string, b: string, free: boolean): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => (free ? 0 : j));
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return free ? Math.min(...prev) : prev[b.length]!;
}

/** Character-bigram Dice coefficient (0..1), for texts too long for the edit distance. */
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
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

/** Whole-line similarity (0..1) of two normalized texts: 1 − edit distance / the longer length. */
export function lineSimilarity(a: string, b: string): number {
  const x = normalizeEcho(a);
  const y = normalizeEcho(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length > NEEDLE_MAX || y.length > NEEDLE_MAX) return dice(x, y);
  return 1 - distance(x, y, false) / Math.max(x.length, y.length);
}

/**
 * How well `needle` reads as a stretch of `hay` (0..1): 1 − the edit distance
 * of the needle to its best-matching substring, over the needle's length. One
 * sentence of a long reply heard back scores near 1; a line longer than the
 * text it is compared with is never inside it (his own words added on top).
 */
export function containedSimilarity(needle: string, hay: string): number {
  const n = normalizeEcho(needle);
  const h = normalizeEcho(hay).slice(0, HAY_MAX);
  if (!n || !h || n.length > h.length * 1.2) return 0;
  if (h.includes(n)) return 1;
  if (n.length > NEEDLE_MAX) return dice(n, h);
  return Math.max(0, 1 - distance(n, h, true) / n.length);
}

/** The chat line fields a match reads (packages/debug-chat/src/wire.ts ChatMessage). */
export type EchoLine = {
  id: string;
  from: "owner" | "friend" | "agent";
  label: string;
  text: string;
  at: number;
  source?: string;
  raw?: string;
  edited?: { at: number; by: string; count: number };
  parts?: readonly { text: string; at: number }[];
  collapsedInto?: string;
  quiet?: true;
};

/** The incoming voice line, as the hub has it before posting. */
export type EchoCandidate = { text: string; label: string; at: number };
export type EchoConf = {
  /** His line from another device: this long after its latest words. */
  windowMs: number;
  /** A line read aloud (an agent's, or his polished one read back): this long after it landed. */
  readWindowMs: number;
  similarity: number;
  /** A shorter line ("好", "嗯") is never an echo: too easy to match by chance. */
  minChars: number;
};
export type EchoKind = "other-device" | "read-aloud";
export type EchoHit<K> = { entry: readonly [K, EchoLine]; kind: EchoKind; sim: number };

/**
 * The stored line this incoming voice line echoes, from the owner thread's
 * kept lines (newest first), or undefined (post it):
 * - his voice line from ANOTHER page (label) within `windowMs` of its latest
 *   words, the same sentence or a stretch of it (his line on the same page is
 *   never an echo: a repeat there is his own);
 * - an agent line that is read aloud (not `quiet`) within `readWindowMs` of
 *   landing, or his voice line polished (and so read back) within
 *   `readWindowMs` of the polish, with the incoming line a stretch of it.
 */
export function echoMatch<K>(
  kept: readonly (readonly [K, EchoLine])[],
  cur: EchoCandidate,
  conf: EchoConf,
): EchoHit<K> | undefined {
  if (normalizeEcho(cur.text).length < conf.minChars) return undefined;
  const reach = Math.max(conf.windowMs, conf.readWindowMs);
  if (reach <= 0) return undefined;
  let best: EchoHit<K> | undefined;
  for (const entry of kept) {
    const x = entry[1];
    // Newest first, but a polish can land late on an older line: look a little further.
    if (cur.at - x.at > 2 * reach) break;
    if (x.collapsedInto) continue;
    let sim = 0;
    let kind: EchoKind = "other-device";
    if (x.from === "agent") {
      if (x.quiet || cur.at - x.at > conf.readWindowMs) continue;
      sim = containedSimilarity(cur.text, x.text);
      kind = "read-aloud";
    } else if (x.from === "owner" && x.label !== cur.label) {
      const lastWords = Math.max(x.at, x.parts?.at(-1)?.at ?? 0);
      if (cur.at - lastWords <= conf.windowMs) {
        const texts = [x.text, x.raw ?? "", ...(x.parts?.map((p) => p.text) ?? [])];
        for (const t of texts)
          if (t) sim = Math.max(sim, lineSimilarity(t, cur.text), containedSimilarity(cur.text, t));
      }
      // His polished line was read back: its new text may come back from the other phone.
      if (x.edited && x.edited.count > 0 && cur.at - x.edited.at <= conf.readWindowMs) {
        const read = containedSimilarity(cur.text, x.text);
        if (read > sim) {
          sim = read;
          kind = "read-aloud";
        }
      }
    } else continue;
    if (sim >= conf.similarity && (!best || sim > best.sim)) best = { entry, kind, sim };
  }
  return best;
}
