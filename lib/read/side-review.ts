/**
 * The reader's side-by-side word review (docs/books-plan.md, "Side-by-side
 * word review"; owner, 2026-11-04 15:56 JST): the book stays on screen, one
 * /words card sits beside it, and D / N jump to the next word of the text
 * that is due on his cards or new to him. The pure parts: which book words
 * are due (server), and where the next such word is in the text (device).
 * Language rules come from the word model (foldsOf, termKeys): no
 * per-language code here.
 */
import type { Fam, Sentence } from "./reader-model";
import { foldsOf, statsLemmas, termKeys, type WordStats } from "./words";

export type DueCardRow = {
  term: string;
  reading: string | null;
  lang: string;
  /** The card's due time as stored (ts-fsrs card JSON: an ISO string). */
  due: string | null;
};

/** The book's words (the word map's keys) whose card is due at `now`. */
export function dueBookWords(stats: WordStats, rows: readonly DueCardRow[], now: number): string[] {
  const due = new Set<string>();
  for (const r of rows) {
    const at = r.due ? Date.parse(r.due) : NaN;
    if (!(at <= now)) continue;
    const lang = r.lang.toLowerCase().split(/[-_]/)[0];
    for (const k of termKeys(r.term, r.reading, lang)) due.add(k);
  }
  if (!due.size) return [];
  const lem = statsLemmas(stats);
  return stats.words
    .map(([w]) => w)
    .filter((w) => foldsOf(w, stats.lang, lem).some((f) => due.has(f)));
}

/** What a jump looks for: a word due on his cards, or a new one (a list's or the dictionary's, no card). */
export type SideKind = "due" | "new";

/** A word's place in the text: its paragraph line and token index there. */
export type WordAt = { line: number; t: number };

export const cmpAt = (a: WordAt, b: WordAt) => a.line - b.line || a.t - b.t;

/** The kind a word is for the side review, or null when neither. */
export function sideKindOf(
  w: string,
  fam: ReadonlyMap<string, Fam> | null,
  due: ReadonlySet<string>,
  done: ReadonlySet<string>,
): SideKind | null {
  if (done.has(w)) return null;
  if (due.has(w)) return "due";
  return fam?.get(w) === "n" ? "new" : null;
}

/**
 * The next (dir 1) or previous (dir -1) word of `kind` from `from` (not
 * `from` itself), scanning paragraph by paragraph; `kind` null takes either.
 * `sentences(line)` is null for a blank line or a heading. Null: none.
 */
export function findWord(
  from: WordAt,
  dir: 1 | -1,
  kind: SideKind | null,
  lineCount: number,
  sentences: (line: number) => readonly Sentence[] | null,
  kindOf: (w: string) => SideKind | null,
): (WordAt & { w: string; kind: SideKind }) | null {
  for (let l = from.line; l >= 0 && l < lineCount; l += dir) {
    const ss = sentences(l);
    if (!ss) continue;
    const segs = ss.flatMap((s) => s.segs);
    const order = dir === 1 ? segs : [...segs].reverse();
    for (const g of order) {
      if (!g.w || g.t < 0) continue;
      if (l === from.line && (dir === 1 ? g.t <= from.t : g.t >= from.t)) continue;
      const k = kindOf(g.w);
      if (k && (kind === null || k === kind)) return { line: l, t: g.t, w: g.w, kind: k };
    }
  }
  return null;
}
