// Word segments for /read: Intl.Segmenter's, with the languages' joins
// applied (lib/read/lang, LangData.joins). Intl.Segmenter cuts scripts
// without spaces by dictionary, so an inflected Japanese verb can come out in
// pieces — かついで as か|ついで (owner, 2026-11-05 14:17 JST: "it cuts into
// two words"), 食べて as 食|べ|て. The joins put them back, as data; the
// engine below is the same for every language.
//
// Every place that cuts text into words for the reader goes through here (the
// paragraph's tokens, the book's word count, the selection's phrase tokens,
// a sentence's reading load), so a token's counted word is a key of the
// book's word map and a token index means the same word everywhere.

import { JOINS, type JoinRule } from "./lang";

/** One segment: its text, its offset in the text segmented, and whether it is a word. */
export interface WordSeg {
  segment: string;
  index: number;
  isWordLike: boolean;
}

function joins(rules: readonly JoinRule[], prev: string, a: string, b: string): boolean {
  for (const r of rules)
    if (r.a.test(a) && r.b.test(b) && (!r.prev || r.prev.test(prev))) return true;
  return false;
}

/**
 * Segments of `text` that join back into it exactly: Intl.Segmenter's, with
 * adjacent word-like segments joined where a join rule says they are one word.
 */
export function wordSegments(
  seg: Intl.Segmenter,
  text: string,
  rules: readonly JoinRule[] = JOINS,
): WordSeg[] {
  const out: WordSeg[] = [];
  for (const s of seg.segment(text)) {
    const word = !!s.isWordLike;
    const last = out[out.length - 1];
    if (
      word &&
      last?.isWordLike &&
      rules.length &&
      joins(rules, out[out.length - 2]?.segment ?? "", last.segment, s.segment)
    ) {
      last.segment += s.segment;
      continue;
    }
    out.push({ segment: s.segment, index: s.index, isWordLike: word });
  }
  return out;
}
