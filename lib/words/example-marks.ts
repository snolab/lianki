/**
 * Familiarity marks inside a /words example sentence (owner, 2026-11-03
 * 19:32 JST: "在例句里面，用到的词，如果它们有卡片的话，就显示对应的颜色来表示熟悉程度").
 *
 * A word of the example that has one of the user's cards (its own form, a
 * fold or a lemma of it, matched by /api/words/familiarity as the reader
 * matches a book) is marked by how well it is known; a word with no card
 * stays plain. The reader's scheme (docs/books-plan.md): the line style
 * tells the level first (colour-blind safe), the oklch tint second, and a
 * mastered word is not marked.
 *
 * The list is virtualised, so the page asks for the words of the rows it
 * renders, once each, in one request per window (missingWords), and keeps
 * the answers for the session. Each example is cut into segments once.
 */
import { segmentsOf } from "@/lib/read/words";

/** One word's card, as the route answers it: score 0..1 (wordScore), mastered 0|1. */
export type FamHit = readonly [number, 0 | 1];
/** lang → word → its card, or null: asked, and no card. */
export type FamMap = Map<string, Map<string, FamHit | null>>;

/** Below this score (ln(1+stability) against a year: about two weeks) a word is still weak. */
export const WEAK_SCORE = 0.5;

/** A word's mark: weak (solid line) or learning (dashed line); none without a card or once mastered. */
export type FamMark = "weak" | "learning" | null;
export function famMark(hit: FamHit | null | undefined): FamMark {
  if (!hit || hit[1]) return null;
  return hit[0] < WEAK_SCORE ? "weak" : "learning";
}

/** The primary subtag a list's language is matched in. */
export const famLang = (lang: string) => lang.toLowerCase().split(/[-_]/)[0] || "und";

type Segment = { text: string; word: string | null };
const SEG_CAP = 4000;
const segCache = new Map<string, Segment[]>();
/** The example cut into segments (lib/read/words.ts segmentsOf), once per text. */
export function exampleSegments(text: string, lang: string): Segment[] {
  const k = `${lang}\n${text}`;
  let s = segCache.get(k);
  if (!s) {
    s = segmentsOf(text, famLang(lang));
    if (segCache.size >= SEG_CAP) segCache.delete(segCache.keys().next().value!);
    segCache.set(k, s);
  }
  return s;
}

/** The words of these examples not asked about yet, per language (each once). */
export function missingWords(
  items: Iterable<{ ex?: string; lang: string }>,
  known: FamMap,
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const it of items) {
    if (!it.ex) continue;
    const lang = famLang(it.lang);
    if (lang === "und") continue;
    const have = known.get(lang);
    for (const s of exampleSegments(it.ex, it.lang)) {
      if (!s.word || have?.has(s.word)) continue;
      let set = out.get(lang);
      if (!set) out.set(lang, (set = new Set()));
      set.add(s.word);
    }
  }
  return new Map([...out].map(([l, s]) => [l, [...s]]));
}

/** Record an answer: every word asked gets its card or null, so none is asked twice. */
export function recordHits(
  known: FamMap,
  lang: string,
  asked: string[],
  hits: Record<string, FamHit>,
): void {
  let m = known.get(lang);
  if (!m) known.set(lang, (m = new Map()));
  for (const w of asked) m.set(w, hits[w] ?? null);
}
