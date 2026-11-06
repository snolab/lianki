// What the selection card translates by itself (owner, 2026-11-05 00:35–00:38
// JST, /read): the selection grown to whole units, each unit translated once
// and cached as itself (our API, lib/read/translate.ts; the shared cache is
// keyed by the unit's own text, so a sentence and a paragraph are separate
// entries).
//
// Owner, 2026-11-06: whole sentences are the unit, always. A selection grows to
// whole sentences, each is translated once and cached as itself, and the card
// stitches them in order, so growing a selection asks only for the new ones.
//
// - **A sentence** (the combo's sentence level): that sentence.
// - **A paragraph**: its sentences.
// - **A hand-made range**: its ragged head and tail grown to whole sentences
//   (Intl.Segmenter's, lib/read/reader-model.ts), a block per paragraph.
//
// - **A phrase** that is no deck card (the caller passes none for a card):
//   the phrase itself, one piece (owner, 2026-11-05 02:11 JST: no Translate
//   button; translation happens by itself).
//
// A word is not translated: its meaning is the deck card's
// (lib/read/select-meaning.ts), else its gloss (/api/read/[id]/gloss).
// Pure, so unit-tested (unit/read-select-translate.test.ts).

import type { Sentence } from "./reader-model";
import { rangeParts, tokenText, type Unit } from "./reader-select";
import { MAX_TRANSLATE_CHARS, normText } from "./translate";

/** One unit to translate: a sentence or a whole paragraph. */
export interface TransPiece {
  level: "sentence" | "para" | "phrase";
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
    if (u.kind === "phrase") {
      const ss = sentences(u.line);
      const text = ss ? normText(tokenText(ss, u.t0, u.t1)) : "";
      return text ? [[{ level: "phrase" as const, line: u.line, s: -1, text }]] : [];
    }
    if (u.kind === "para") {
      const ss = sentences(u.line);
      return ss ? [sentencePieces(u.line, ss, 0, ss.length - 1)] : [];
    }
    if (u.kind !== "range") return null;
    return rangeParts(u).flatMap((p) => {
      const ss = sentences(p.line);
      const span = ss && sentenceSpan(ss, p.from, p.to);
      return ss && span ? [sentencePieces(p.line, ss, span[0], span[1])] : [];
    });
  })();
  if (!plan) return null;
  const out = plan.filter((b) => b.length);
  return out.length ? out : null;
}

/**
 * A hand-made range as it is drawn: grown to the whole sentences it touches,
 * which is what gets translated. The unit itself keeps the words he picked, for
 * a phrase card.
 */
export function wholeSentenceRange(
  u: Extract<Unit, { kind: "range" }>,
  sentences: (line: number) => readonly Sentence[] | null,
): Extract<Unit, { kind: "range" }> {
  const edge = (line: number, t: number, last: boolean) => {
    const ss = sentences(line);
    const span = ss && sentenceSpan(ss, t, t);
    if (!ss || !span) return t;
    const toks = ss[span[0]].segs.filter((g) => g.t >= 0);
    return toks.length ? toks[last ? toks.length - 1 : 0].t : t;
  };
  return { ...u, t0: edge(u.l0, u.t0, false), t1: edge(u.l1, u.t1, true) };
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
