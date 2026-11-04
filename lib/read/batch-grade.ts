// Grading from the reader's selection card (docs/books-plan.md, "Grading
// from the selection card"; owner, 2026-11-05 02:50–03:20 JST): one handle
// on the card grades whatever is selected — a word, a phrase, a sentence, a
// hand-made range (every sentence in it, as one batch), a paragraph (as its
// swipe). The rules, pure, shared by the device and the server:
//
// - Only due cards and new items are graded. A word: its card due now, or a
//   new card (never reviewed). A sentence: never graded, or due now. Not-due
//   ones are skipped and counted; the server applies the same filter again.
// - A word or phrase without a card offers 制卡 first; the handle comes once
//   the card exists. One not due: no handle, only when it is due.
// - A range graded Easy takes its new and due words along (same batch, one
//   undo); any other grade opens the range's word review when it has some.
//   A single sentence never takes words along.

import type { SwipeRating } from "@/lib/words/swipe";

/** What the handle grades, as its hint names it. */
export type HandleTarget = "word" | "phrase" | "sentence" | "sentences" | "para";

/** A word of the selection as the server's probe answers it. */
export interface WordProbe {
  w: string;
  listId: string | null;
  term: string | null;
  /** Its card's due (ISO); null: no card. */
  due: string | null;
  reps: number;
  /** The due each grade would give, for the card's "next" line (ISO, by rating). */
  next?: Partial<Record<SwipeRating, string>>;
}

/** A sentence's due (ISO), or null when it was never graded. */
export type SentenceProbe = Record<string, string | null>;

export const isDue = (due: string | null, now: number) => {
  if (due === null) return true;
  const t = Date.parse(due);
  return !Number.isFinite(t) || t <= now;
};

/** A word as the handle sees it. */
export type WordState =
  | { kind: "nocard" }
  | { kind: "due"; isNew: boolean }
  | { kind: "notDue"; due: string };

export function wordState(p: WordProbe | undefined, now: number): WordState {
  if (!p || !p.listId || p.due === null) return { kind: "nocard" };
  if (p.reps === 0) return { kind: "due", isNew: true };
  return isDue(p.due, now) ? { kind: "due", isNew: false } : { kind: "notDue", due: p.due };
}

/** Sentences to grade (never graded, or due) and the not-due ones skipped. */
export function splitSentences(
  sids: readonly string[],
  probe: SentenceProbe,
  now: number,
): { grade: string[]; skipped: string[] } {
  const grade: string[] = [];
  const skipped: string[] = [];
  for (const sid of new Set(sids)) (isDue(probe[sid] ?? null, now) ? grade : skipped).push(sid);
  return { grade, skipped };
}

/** Words a batch takes: due or new cards, and words with no card (made first). */
export function splitWords(
  words: readonly WordProbe[],
  now: number,
): { grade: WordProbe[]; make: WordProbe[]; skipped: WordProbe[] } {
  const grade: WordProbe[] = [];
  const make: WordProbe[] = [];
  const skipped: WordProbe[] = [];
  const seen = new Set<string>();
  for (const p of words) {
    const s = wordState(p, now);
    if (s.kind === "nocard") {
      if (seen.has(`w\u0000${p.w}`)) continue;
      seen.add(`w\u0000${p.w}`);
      make.push(p);
      continue;
    }
    // Two forms of one word ("regarda", "regarde") are one card: graded once.
    const key = `${p.listId}\u0000${p.term}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (s.kind === "due" ? grade : skipped).push(p);
  }
  return { grade, make, skipped };
}

/** What the card offers for the selection. */
export type HandlePlan =
  /** Nothing to grade here (a chapter, the book, signed out, still loading). */
  | { mode: "none" }
  /** A word or phrase with no card: 制卡 first. */
  | { mode: "make"; target: "word" | "phrase"; w: string }
  /** A word or phrase not due: when it is. */
  | { mode: "notDue"; target: "word" | "phrase"; due: string }
  /** The handle; `disabled` when nothing in the selection is due or new. */
  | {
      mode: "grade";
      target: HandleTarget;
      /** Sentences graded by the batch (a word's or a paragraph's: none). */
      sentences: string[];
      skipped: number;
      /** Words graded: a word or phrase's own card; a range's due + new words (Easy only). */
      words: WordProbe[];
      /** A range's words with no card yet (Easy makes them, then grades them). */
      make: WordProbe[];
      disabled: "nothingDue" | null;
    };

export type UnitKind = "word" | "phrase" | "sentence" | "para" | "range" | "chapter" | "book";

/**
 * The plan for a selection. `sids` are the unit's sentences (a sentence or a
 * range), `words` its words as probed (a word or phrase: just that one).
 * `probe` is null while it loads.
 */
export function handlePlan(
  kind: UnitKind,
  probe: { sentences: SentenceProbe; words: WordProbe[] } | null,
  sids: readonly string[],
  now: number,
): HandlePlan {
  if (kind === "chapter" || kind === "book") return { mode: "none" };
  // A paragraph is graded as its swipe grades it (the item's own path).
  if (kind === "para")
    return {
      mode: "grade",
      target: "para",
      sentences: [],
      skipped: 0,
      words: [],
      make: [],
      disabled: null,
    };
  if (!probe) return { mode: "none" };
  if (kind === "word" || kind === "phrase") {
    const p = probe.words[0];
    if (!p) return { mode: "none" };
    const s = wordState(p, now);
    if (s.kind === "nocard") return { mode: "make", target: kind, w: p.w };
    if (s.kind === "notDue") return { mode: "notDue", target: kind, due: s.due };
    return {
      mode: "grade",
      target: kind,
      sentences: [],
      skipped: 0,
      words: [p],
      make: [],
      disabled: null,
    };
  }
  const { grade, skipped } = splitSentences(sids, probe.sentences, now);
  const w = kind === "range" ? splitWords(probe.words, now) : { grade: [], make: [] };
  return {
    mode: "grade",
    target: grade.length + skipped.length > 1 ? "sentences" : "sentence",
    sentences: grade,
    skipped: skipped.length,
    words: w.grade,
    make: w.make,
    disabled: grade.length ? null : "nothingDue",
  };
}

/** What one grade of the plan writes, and whether the range's word review opens after it. */
export function batchOf(
  plan: Extract<HandlePlan, { mode: "grade" }>,
  rating: SwipeRating,
): { sentences: string[]; words: WordProbe[]; make: WordProbe[]; openReview: boolean } {
  if (plan.target === "word" || plan.target === "phrase")
    return { sentences: [], words: plan.words, make: [], openReview: false };
  if (plan.target === "para") return { sentences: [], words: [], make: [], openReview: false };
  // A single sentence never takes words along; a range does, on Easy.
  const range = plan.target === "sentences" || plan.words.length + plan.make.length > 0;
  const easy = rating === 4 && range;
  return {
    sentences: plan.sentences,
    words: easy ? plan.words : [],
    make: easy ? plan.make : [],
    openReview: range && rating !== 4 && plan.words.length + plan.make.length > 0,
  };
}

/** The hint's parts: the target and its count, the words along, the skipped. */
export function hintParts(
  plan: Extract<HandlePlan, { mode: "grade" }>,
  rating: SwipeRating | null,
): { target: HandleTarget; n: number; words: number; skipped: number } {
  const b = rating ? batchOf(plan, rating) : null;
  return {
    target: plan.target,
    n: plan.target === "sentences" ? plan.sentences.length : 1,
    words:
      b && plan.target !== "word" && plan.target !== "phrase" ? b.words.length + b.make.length : 0,
    skipped: plan.skipped,
  };
}
