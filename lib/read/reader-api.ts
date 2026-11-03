// The reader v2 contract (docs/books-plan.md, "Review units"): the types the
// /read UI and the /api/read/[id]/* routes share. Client-safe: types and a few
// pure helpers only, no D1, no Intl work.
//
// Units. The atomic unit is the SENTENCE, with a stable id derived from the
// book's content hash, its line and its index in that line. FSRS state lives on
// sentences. An ITEM (what one swipe grades) is a run of whole sentences, sized
// by reading time (lib/read/units.ts); grading an item grades each of its
// sentences, so changing granularity loses no history.
//
// Every route below answers 404 unless reader v2 is on for the signed-in user
// (flag `read.reader-v2`, or the owner), and only ever reads or writes that
// user's rows for a material they own.

/** What one swipe grades: a sentence, a paragraph, or a span of reading time. */
export type Granularity = "sentence" | "paragraph" | "time";
export const GRANULARITIES: readonly Granularity[] = ["sentence", "paragraph", "time"];

/** Again / Hard / Good / Easy, as on cards (ts-fsrs Rating). */
export type ReadRating = 1 | 2 | 3 | 4;

/** `${bookHash}:${line}.${index}`, e.g. "3f2a9c0d41b7e6aa:120.2". */
export type SentenceId = string;

/** A sentence's place: [line, index in the line, start, end] (UTF-16 offsets into lines[line]). */
export type SentenceRef = [line: number, index: number, start: number, end: number];

export function sentenceId(bookHash: string, line: number, index: number): SentenceId {
  return `${bookHash}:${line}.${index}`;
}

const SID = /^([0-9a-f]{16}):(\d{1,7})\.(\d{1,5})$/;

export function parseSentenceId(
  sid: unknown,
): { bookHash: string; line: number; index: number } | null {
  if (typeof sid !== "string") return null;
  const m = SID.exec(sid);
  return m ? { bookHash: m[1], line: Number(m[2]), index: Number(m[3]) } : null;
}

// ── Book text: inline markup and in-paragraph breaks (stored in BookMeta) ──

/** Inline emphasis kept from the EPUB: a closed set, never HTML. */
export type InlineKind = "em" | "strong" | "sup" | "sub";
export const INLINE_KINDS: readonly InlineKind[] = ["em", "strong", "sup", "sub"];

/** [line, start, end, kind]: UTF-16 offsets into lines[line], start < end. */
export type InlineMark = [line: number, start: number, end: number, kind: InlineKind];

/**
 * A paragraph: lines [start, end). A paragraph spans several lines when the
 * EPUB had a line break inside it (`<br>`, joined by a visible break) or when a
 * long paragraph was split at import (joined with a space).
 */
export interface Paragraph {
  start: number;
  end: number;
  /** Lines in (start, end) that follow a visible line break, not a space. */
  breaks: number[];
}

// ── Familiarity (lib/read/familiarity.ts) ──

/**
 * Familiarity of a unit (sentence, item, paragraph, chapter, book). Every
 * share is 0..1 and token-weighted (a sentence weighs its running words).
 */
export interface Familiarity {
  /** Running words (lib/read/words.ts), the weight. */
  tokens: number;
  /** Mean word score of its running words (lib/words/progress.ts wordScore; names = 1). */
  vocab: number;
  /** Share of running words mastered or names: the 95% coverage rule. */
  coverage: number;
  /** Mean sentence FSRS score (same log scale as words; never graded = 0). */
  grade: number;
  /** Share of running words in sentences whose last grade was Good or Easy. */
  understood: number;
  /** Share of running words in sentences graded at least once. */
  graded: number;
  /** What to show: min(vocab, grade) — known words alone never make it familiar. */
  value: number;
}

/** A sentence's FSRS state for this user (absent = never graded). */
export interface SentenceState {
  due: string;
  stability: number;
  reps: number;
  lapses: number;
  /** ts-fsrs State: 0 New, 1 Learning, 2 Review, 3 Relearning. */
  state: 0 | 1 | 2 | 3;
  lastRating: ReadRating;
  lastAt: string;
}

// ── GET /api/read/[id]/items?g=<granularity>&from=<line>&to=<line>&seconds=<n> ──
//
// Items of every chapter that overlaps lines [from, to) (default: the chapter
// holding `from`, from = 0). Items never cross a chapter and do not depend on
// the window asked for, so keys are stable across requests. `seconds` is the
// span for g=time (default: the user's typical read before a swipe).

export interface ItemBounds {
  /** Items take at least this long to read (merging short ones). */
  minSeconds: number;
  /** Items longer than this are split at sentence ends; null = never split. */
  maxSeconds: number | null;
  /** The span packed for g=time. */
  targetSeconds?: number;
  /** Reading speed used to estimate time: word-like segments per second. */
  wordsPerSecond: number;
  /** Where each came from: "prior" until the user has enough reads of their own. */
  speedSource: "prior" | "user";
  boundsSource: "prior" | "user";
  /** The user's graded reads in this language the numbers came from. */
  samples: number;
}

export interface ReadItem {
  /** `${first sid}+${sentence count}`: stable for the same bounds. */
  key: string;
  sentences: SentenceRef[];
  chapter: number;
  /** Word-like segments (numbers included): the reading load. */
  words: number;
  /** Estimated reading time at the user's speed. */
  seconds: number;
  fam: Familiarity;
  /** Earliest due among its graded sentences (ISO), or null. */
  due: string | null;
}

export interface ItemsResponse {
  bookHash: string;
  lang: string;
  granularity: Granularity;
  /** The chapters returned, by index into book.chapters. */
  chapters: number[];
  /** Lines covered: [start, end). */
  lines: [number, number];
  bounds: ItemBounds;
  items: ReadItem[];
  /** States of the graded sentences in these items. */
  cards: Record<SentenceId, SentenceState>;
}

// ── POST /api/read/[id]/grade ──

export interface GradeRequest {
  /** The item's sentences (each graded with the same rating). */
  sentences: SentenceId[];
  rating: ReadRating;
  granularity: Granularity;
  /** When the item came into view and when the swipe started (ISO): the reading time. */
  shownAt?: string;
  swipedAt?: string;
  /** Client-made id (UUID) so a retried request grades once. */
  clientId?: string;
  /** Optional note for this read. */
  note?: string;
}

export interface GradeResponse {
  reviewId: string;
  /** True when this clientId was already graded: nothing changed. */
  duplicate: boolean;
  cards: Record<SentenceId, SentenceState>;
  fam: Familiarity;
  note: ReadNote | null;
}

// ── GET /api/read/[id]/history?from=<line>&to=<line> ──

export interface ReadReview {
  id: string;
  at: string;
  rating: ReadRating;
  granularity: Granularity;
  first: SentenceId;
  last: SentenceId;
  count: number;
  /** Measured reading time before the swipe, ms (null when not sent). */
  dwellMs: number | null;
}

export interface HistoryResponse {
  reviews: ReadReview[];
  notes: ReadNote[];
}

// ── GET / PUT (or POST, for sendBeacon) /api/read/[id]/progress ──

export interface ReadAnchor {
  line: number;
  /** 0..1: how far into the line the reading line sits. */
  offset: number;
  /** When the client took it (ISO): the newest anchor wins. */
  at: string;
}

export interface ProgressPut {
  line: number;
  offset: number;
  at: string;
  /** The furthest line read with real reading time; only ever grows. */
  highLine?: number;
}

export interface ProgressResponse {
  anchor: ReadAnchor | null;
  /** The high-water mark (bookmark, extraction trigger), or null. */
  highLine: number | null;
  /** Lines the high-water mark just moved over [from, to): extract these. Absent when it did not move. */
  advanced?: [number, number];
}

// ── POST /api/read/[id]/exposures ──
//
// Words seen in context go to an exposure log only; they never change a word's
// FSRS state (books-plan, option A). "seen": the sentence passed the reading
// line. "lookup" / "select" / "note": an explicit "not recognised" for a word.

export type ExposureKind = "seen" | "lookup" | "select" | "note";

export interface ExposureEvent {
  kind: ExposureKind;
  sid: SentenceId;
  /** The word, as written in the sentence (explicit kinds only). */
  word?: string;
  at: string;
}

export interface ExposureBatch {
  events: ExposureEvent[];
}

export interface ExposureResponse {
  /** Events recorded now. */
  accepted: number;
  /** Already logged today (a resend): not counted again. */
  duplicates: number;
  /** Malformed or not of this book. */
  rejected: number;
}

// ── Notes: GET/POST /api/read/[id]/notes, PATCH/DELETE /api/read/[id]/notes/[noteId] ──

export interface ReadNote {
  id: string;
  first: SentenceId;
  last: SentenceId;
  /** The read this note was written on, or null for a free note. */
  reviewId: string | null;
  text: string;
  createdAt: string;
  updatedAt: string;
  /** Earlier texts, oldest first. */
  history: { text: string; at: string }[];
}

export interface NoteCreate {
  first: SentenceId;
  last: SentenceId;
  text: string;
  reviewId?: string;
}

export interface NotePatch {
  text: string;
}

// ── GET /api/read/[id]/familiarity ──

export interface FamiliarityResponse {
  bookHash: string;
  book: Familiarity;
  /** By index into book.chapters. */
  chapters: Familiarity[];
  pass: {
    /** The coverage line, 0..1 (lib/read/words.ts BOOK_PASS_COVERAGE). */
    line: number;
    /** Word coverage passes (the existing ✓). */
    words: boolean;
    /** Understood share passes the same line. */
    understood: boolean;
    /** Both: the book is read and understood. */
    passed: boolean;
  };
}

// ── GET /api/read/[id]/due ──

export interface DueResponse {
  now: string;
  /** Sentences due now, in reading order. */
  due: { sid: SentenceId; line: number; index: number; due: string }[];
  /** The next due time after now (ISO), or null. */
  next: string | null;
}

// ── GET /api/read/[id] (existing) gains: ──

export interface ReaderV2Fields {
  /** Reader v2 is on for this user. */
  readerV2: boolean;
  /** The content hash sentence ids start with. */
  bookHash?: string;
}
