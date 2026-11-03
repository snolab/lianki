// Combo-click expanding selection in the reader v2 (docs/books-plan.md,
// "Combo-click expanding selection", owner 2026-11-03 18:38 JST). Pure and
// isomorphic: the level state machine, the units' deep-link fragments and
// the familiarity summary a unit's card shows. The DOM side (one delegated
// listener, the highlight, the card) is in app/(app)/read/[id]/ReaderV2.tsx.
//
// - **Levels.** Each extra click within the double-click interval selects the
//   next larger unit: word → phrase → sentence → paragraph → chapter → book.
//   A level the click has no unit for is skipped (a phrase until extraction
//   gives phrase bounds; a word or a sentence on a heading; a chapter in a
//   book without chapters). A pause, or a click outside the selected unit,
//   starts again at the smallest unit under the click.
// - **Addresses.** Positions in the book's `lines` (lib/read/reader-model.ts):
//   a paragraph is its line, a sentence its index in the line, a word its
//   token index in the line (word-like segments from 0). With the book's
//   content hash in the path they survive a re-import of the same text:
//   `/read/<book>` · `#ch=<n>` · `#p=<line>` · `#s=<line>.<sentence>` ·
//   `#w=<line>.<token>` · `#ph=<line>.<start>-<end>`.

import type { Fam, Sentence } from "./reader-model";

export type Unit =
  | { kind: "word"; line: number; t: number }
  | { kind: "phrase"; line: number; t0: number; t1: number }
  | { kind: "sentence"; line: number; s: number }
  | { kind: "para"; line: number }
  | { kind: "chapter"; n: number }
  | { kind: "book" };

export type Level = Unit["kind"];

/** Smallest to largest: one level up per click. */
export const LEVELS: readonly Level[] = ["word", "phrase", "sentence", "para", "chapter", "book"];

/**
 * The double-click interval, ms. The web exposes no platform setting; this is
 * the common default of desktop systems and the figure the owner's spec names
 * (≈ 350 ms), measured between `pointerdown` timestamps.
 */
export const COMBO_MS = 350;

/** What a click landed on: a paragraph (or heading) line, and the sentence and word in it. */
export interface Hit {
  line: number;
  /** Sentence index in the line; null on a heading or between sentences. */
  s: number | null;
  /** Token index in the line; null when not on a word. */
  t: number | null;
}

export interface ComboCtx {
  interval: number;
  /** The phrase holding token `t` of `line`, [start, end] tokens; null without phrase data. */
  phraseAt(line: number, t: number): [number, number] | null;
  /** The chapter holding a line, or -1 (a book without chapters). */
  chapterAt(line: number): number;
  /** A chapter's lines, [start, end). */
  chapterRange(n: number): [number, number] | null;
}

export interface Combo {
  unit: Unit;
  /** The last click's pointerdown time (ms, any monotonic clock). */
  at: number;
}

/** The unit of `level` under a hit, or null when there is none. */
export function unitFor(level: Level, hit: Hit, ctx: ComboCtx): Unit | null {
  switch (level) {
    case "word":
      return hit.t === null ? null : { kind: "word", line: hit.line, t: hit.t };
    case "phrase": {
      if (hit.t === null) return null;
      const ph = ctx.phraseAt(hit.line, hit.t);
      // A one-word "phrase" is the word again: skipped.
      return ph && ph[1] > ph[0] ? { kind: "phrase", line: hit.line, t0: ph[0], t1: ph[1] } : null;
    }
    case "sentence":
      return hit.s === null ? null : { kind: "sentence", line: hit.line, s: hit.s };
    case "para":
      return { kind: "para", line: hit.line };
    case "chapter": {
      const n = ctx.chapterAt(hit.line);
      return n >= 0 ? { kind: "chapter", n } : null;
    }
    case "book":
      return { kind: "book" };
  }
}

/** Whether a click on `hit` falls inside `u` (so it can carry the combo on). */
export function unitHolds(u: Unit, hit: Hit, ctx: ComboCtx): boolean {
  switch (u.kind) {
    case "word":
      return hit.line === u.line && hit.t === u.t;
    case "phrase":
      return hit.line === u.line && hit.t !== null && hit.t >= u.t0 && hit.t <= u.t1;
    case "sentence":
      return hit.line === u.line && hit.s === u.s;
    case "para":
      return hit.line === u.line;
    case "chapter": {
      const r = ctx.chapterRange(u.n);
      return !!r && hit.line >= r[0] && hit.line < r[1];
    }
    case "book":
      return true;
  }
}

/** The smallest unit under a hit (a paragraph always exists). */
export function firstUnit(hit: Hit, ctx: ComboCtx): Unit {
  for (const l of LEVELS) {
    const u = unitFor(l, hit, ctx);
    if (u) return u;
  }
  return { kind: "para", line: hit.line };
}

/** The next larger unit around a hit, after `u`; the book stays the book. */
export function nextUnit(u: Unit, hit: Hit, ctx: ComboCtx): Unit {
  for (let i = LEVELS.indexOf(u.kind) + 1; i < LEVELS.length; i++) {
    const n = unitFor(LEVELS[i], hit, ctx);
    if (n) return n;
  }
  return u;
}

/**
 * One click of a combo: within the interval of the last one and inside the
 * selected unit, one level up; otherwise a new combo at the smallest unit.
 */
export function comboClick(prev: Combo | null, hit: Hit, at: number, ctx: ComboCtx): Combo {
  if (comboContinues(prev, hit, at, ctx)) return { unit: nextUnit(prev!.unit, hit, ctx), at };
  return { unit: firstUnit(hit, ctx), at };
}

/** Whether a click carries `prev`'s combo on (within the interval, inside its unit). */
export function comboContinues(prev: Combo | null, hit: Hit, at: number, ctx: ComboCtx): boolean {
  return (
    !!prev && at - prev.at >= 0 && at - prev.at <= ctx.interval && unitHolds(prev.unit, hit, ctx)
  );
}

// ── Saying the selected unit (owner, 2026-11-03 22:12 / 22:13 JST) ─────

/**
 * What a click of the combo does to the voice. "点击选择某个词的时候，只要朗读那个
 * 词就可以了" / "连点三下，如果是选中句子的话，那就朗读整个句子": each level says
 * exactly the unit it selected — the word, the phrase, the sentence, the
 * paragraph — never its item or the book on from there. A chapter or the book
 * is too long to say on a tap: nothing (their card's "read from here" plays
 * the book). A book playback running then is paused and left paused (he
 * resumes with ▶; the player's current item stays).
 *
 * Timing: the first click says its unit at once (inside the gesture, so a
 * phone lets it sound). Each further click of the combo cuts what is being
 * said and says its larger unit only once the combo has rested for the
 * double-click interval, so a fast triple-click does not stutter through
 * every level on its way to the paragraph.
 */
export type SayUnit = Extract<Unit, { kind: "word" | "phrase" | "sentence" | "para" }>;

export interface TapVoice {
  /** Say this unit (null: say nothing). */
  say: SayUnit | null;
  /** Wait the double-click interval first; another click of the combo cancels it. */
  wait: boolean;
  /** Pause the book playback. */
  pause: boolean;
}

/** Every click cuts what the last one said; this says what comes next. */
export function tapVoice(next: Unit, continued: boolean, playing: boolean): TapVoice {
  if (next.kind === "chapter" || next.kind === "book")
    return { say: null, wait: false, pause: false };
  return { say: next, wait: continued, pause: playing };
}

// ── Deep links ──────────────────────────────────────────────────────────

/** A unit's fragment, with its `#`; the book has none (its link is the book's path). */
export function encodeUnit(u: Unit): string {
  switch (u.kind) {
    case "word":
      return `#w=${u.line}.${u.t}`;
    case "phrase":
      return `#ph=${u.line}.${u.t0}-${u.t1}`;
    case "sentence":
      return `#s=${u.line}.${u.s}`;
    case "para":
      return `#p=${u.line}`;
    case "chapter":
      return `#ch=${u.n}`;
    case "book":
      return "";
  }
}

const N = "(0|[1-9]\\d{0,6})";
const FRAG: [RegExp, (m: RegExpExecArray) => Unit | null][] = [
  [new RegExp(`^w=${N}\\.${N}$`), (m) => ({ kind: "word", line: +m[1], t: +m[2] })],
  [
    new RegExp(`^ph=${N}\\.${N}-${N}$`),
    (m) => (+m[3] > +m[2] ? { kind: "phrase", line: +m[1], t0: +m[2], t1: +m[3] } : null),
  ],
  [new RegExp(`^s=${N}\\.${N}$`), (m) => ({ kind: "sentence", line: +m[1], s: +m[2] })],
  [new RegExp(`^p=${N}$`), (m) => ({ kind: "para", line: +m[1] })],
  [new RegExp(`^ch=${N}$`), (m) => ({ kind: "chapter", n: +m[1] })],
];

/** The unit a fragment names (with or without its `#`), or null. */
export function decodeUnit(hash: string | null | undefined): Unit | null {
  if (!hash) return null;
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const [re, make] of FRAG) {
    const m = re.exec(h);
    if (m) return make(m);
  }
  return null;
}

/** A unit's link: the book's path (its content hash, or else its id) and the unit's fragment. */
export function unitLink(origin: string, book: string, u: Unit): string {
  return `${origin}/read/${encodeURIComponent(book)}${encodeUnit(u)}`;
}

export const sameUnit = (a: Unit | null, b: Unit | null) =>
  !!a && !!b && a.kind === b.kind && encodeUnit(a) === encodeUnit(b);

// ── Familiarity of a unit ───────────────────────────────────────────────

/** Running words of a unit by familiarity (the word map's classes). */
export interface FamCounts {
  /** Running words counted (those the word map knows). */
  n: number;
  /** Mastered, and names. */
  known: number;
  learning: number;
  /** No card, but a list or the dictionary has it. */
  fresh: number;
  unrecognised: number;
}

export const emptyCounts = (): FamCounts => ({
  n: 0,
  known: 0,
  learning: 0,
  fresh: 0,
  unrecognised: 0,
});

/** Adds one running word (its normalised form) to the counts. */
export function countWord(c: FamCounts, w: string | null, fam: ReadonlyMap<string, Fam>): void {
  if (!w) return;
  const f = fam.get(w);
  if (!f) return;
  c.n++;
  if (f === "k") c.known++;
  else if (f === "n") c.fresh++;
  else if (f === "u") c.unrecognised++;
  else c.learning++;
}

/** Counts over sentences, optionally only tokens [t0, t1]. */
export function countSentences(
  ss: readonly Sentence[],
  fam: ReadonlyMap<string, Fam>,
  range?: [number, number],
  into: FamCounts = emptyCounts(),
): FamCounts {
  for (const s of ss)
    for (const g of s.segs) {
      if (g.t < 0) continue;
      if (range && (g.t < range[0] || g.t > range[1])) continue;
      countWord(into, g.w, fam);
    }
  return into;
}

/** The text of tokens [t0, t1] of a paragraph, with what lies between them. */
export function tokenText(ss: readonly Sentence[], t0: number, t1: number): string {
  let out = "";
  let on = false;
  for (const s of ss)
    for (const g of s.segs) {
      if (g.t === t0) on = true;
      if (on) out += g.text;
      if (g.t === t1) return out;
    }
  return out;
}

/** The sentence holding token `t` of a paragraph, or -1. */
export function sentenceOfToken(ss: readonly Sentence[], t: number): number {
  for (let i = 0; i < ss.length; i++) for (const g of ss[i].segs) if (g.t === t) return i;
  return -1;
}

/** The normalised form of token `t`, or null. */
export function tokenWord(ss: readonly Sentence[], t: number): string | null {
  for (const s of ss) for (const g of s.segs) if (g.t === t) return g.w;
  return null;
}

/** UTF-16 offset of token `t` in its line (sentences and segments cover the line exactly). */
export function tokenOffset(ss: readonly Sentence[], t: number): number {
  let off = 0;
  for (const s of ss)
    for (const g of s.segs) {
      if (g.t === t) return off;
      off += g.text.length;
    }
  return -1;
}
