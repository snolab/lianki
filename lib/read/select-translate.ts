// What the selection card translates by itself (owner, 2026-11-05 00:35–00:38
// JST, /read): the selection grown to whole units, each unit translated once
// and cached as itself (our API, lib/read/translate.ts; the shared cache is
// keyed by the unit's own text, so a sentence and a paragraph are separate
// entries).
//
// - **A sentence** (the combo's sentence level): that sentence.
// - **A paragraph**: the paragraph in one call — more fluent than its
//   sentences one by one.
// - **A hand-made range in one paragraph**: its ragged head and tail grown
//   to whole sentences (Intl.Segmenter's, lib/read/reader-model.ts), each
//   sentence translated and cached on its own; grown to the whole paragraph,
//   it is the paragraph.
// - **A range across paragraphs**: when it covers a paragraph whole, every
//   paragraph it touches is taken whole, one call each, shown in order;
//   when it only joins the tail of one to the head of the next, their
//   sentences.
//
// Words and phrases are not translated by themselves: their meaning is the
// deck card's (lib/read/select-meaning.ts), and Translate stays a tap.
// Pure, so unit-tested (unit/read-select-translate.test.ts).

import type { Sentence } from "./reader-model";
import { rangeParts, type Unit } from "./reader-select";
import { MAX_TRANSLATE_CHARS, normText } from "./translate";

/** One unit to translate: a sentence or a whole paragraph. */
export interface TransPiece {
  level: "sentence" | "para";
  line: number;
  /** The sentence's index in the paragraph; -1 for a paragraph. */
  s: number;
  /** The unit's text, normalised as it is cached (lib/read/translate.ts normText). */
  text: string;
}

/** A paragraph's pieces, shown as one block; the blocks in reading order. */
export type TransPlan = TransPiece[][];

/**
 * The characters translated by themselves for one selection; past them, the
 * rest waits for a tap on Translate. A bound on what one long selection
 * spends, never shown.
 */
export const AUTO_TRANSLATE_CHARS = MAX_TRANSLATE_CHARS * 4;

/** The sentences [s0, s1] of a paragraph that hold its tokens `from`…`to` (null: its ends). */
export function sentenceSpan(
  ss: readonly Sentence[],
  from: number | null,
  to: number | null,
): [number, number] | null {
  let s0 = -1;
  let s1 = -1;
  for (let i = 0; i < ss.length; i++)
    for (const g of ss[i].segs) {
      if (g.t < 0) continue;
      if (s0 < 0 && (from === null || g.t >= from)) s0 = i;
      if (to === null || g.t <= to) s1 = i;
    }
  return s0 >= 0 && s1 >= s0 ? [s0, s1] : null;
}

const sentencePieces = (line: number, ss: readonly Sentence[], s0: number, s1: number) => {
  const out: TransPiece[] = [];
  for (let s = s0; s <= s1; s++) {
    const text = normText(ss[s]?.text ?? "");
    if (text) out.push({ level: "sentence", line, s, text });
  }
  return out;
};

/** A whole paragraph: one piece, or its sentences when it is longer than one call takes. */
function paraPieces(line: number, ss: readonly Sentence[]): TransPiece[] {
  const text = normText(ss.map((s) => s.text).join(""));
  if (!text) return [];
  if (text.length <= MAX_TRANSLATE_CHARS) return [{ level: "para", line, s: -1, text }];
  return sentencePieces(line, ss, 0, ss.length - 1);
}

/** What a selected unit translates as, or null when it is not translated by itself. */
export function translationPlan(
  u: Unit,
  sentences: (line: number) => readonly Sentence[] | null,
): TransPlan | null {
  const plan = (() => {
    if (u.kind === "sentence") {
      const ss = sentences(u.line);
      return ss ? [sentencePieces(u.line, ss, u.s, u.s)] : [];
    }
    if (u.kind === "para") {
      const ss = sentences(u.line);
      return ss ? [paraPieces(u.line, ss)] : [];
    }
    if (u.kind !== "range") return null;
    const parts = rangeParts(u).flatMap((p) => {
      const ss = sentences(p.line);
      const span = ss && sentenceSpan(ss, p.from, p.to);
      return ss && span
        ? [{ line: p.line, ss, span, whole: span[0] === 0 && span[1] === ss.length - 1 }]
        : [];
    });
    const allWhole = parts.length > 1 && parts.some((p) => p.whole);
    return parts.map((p) =>
      allWhole || p.whole
        ? paraPieces(p.line, p.ss)
        : sentencePieces(p.line, p.ss, p.span[0], p.span[1]),
    );
  })();
  if (!plan) return null;
  const out = plan.filter((b) => b.length);
  return out.length ? out : null;
}

/** The plan's pieces in order, and which are translated by themselves (within the bound). */
export function autoPieces(plan: TransPlan, budget = AUTO_TRANSLATE_CHARS): Set<TransPiece> {
  const out = new Set<TransPiece>();
  let n = 0;
  for (const b of plan)
    for (const p of b) {
      // The first piece always goes, whatever its size.
      if (out.size && n + p.text.length > budget) return out;
      n += p.text.length;
      out.add(p);
    }
  return out;
}

/** The device's cache key of a unit's translation: the target and the text, as the server keys it. */
export const transKey = (to: string, text: string) => `${to}\n${normText(text)}`;
