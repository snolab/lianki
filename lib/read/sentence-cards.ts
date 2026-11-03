// FSRS on sentences (docs/books-plan.md, "Review units"). Grading an item
// grades each of its sentences with the same rating, each on its own card, so
// a later change of granularity keeps every sentence's history. ts-fsrs 5.x
// with its default parameters (as page cards); fuzz on, as everywhere.
//
// Pure: the store (lib/read/reader-store.ts) loads and saves the cards.

import {
  type Card,
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Grade,
  TypeConvert,
} from "ts-fsrs";
import type { BookSentences } from "./units";
import { textKey } from "./units";
import type { ReadRating, SentenceState } from "./reader-api";

const schedulers = new Map<boolean, ReturnType<typeof fsrs>>();
function scheduler(fuzz: boolean) {
  let s = schedulers.get(fuzz);
  if (!s) {
    s = fsrs(generatorParameters({ enable_fuzz: fuzz }));
    schedulers.set(fuzz, s);
  }
  return s;
}

export function parseSentenceCard(json: string | null | undefined): Card | null {
  if (!json) return null;
  try {
    return TypeConvert.card(JSON.parse(json));
  } catch {
    return null;
  }
}

/** One rating on one sentence's card (null = never graded). */
export function gradeSentence(card: Card | null, rating: ReadRating, now: Date, fuzz = true): Card {
  return scheduler(fuzz).next(card ?? createEmptyCard<Card>(now), now, rating as Grade).card;
}

/** A stored card row as the state the API returns. */
export interface SentenceCardRow {
  sid: string;
  line: number;
  idx: number;
  text_key: string;
  card: string;
  due: string;
  last_rating: number;
  /** The read that last wrote it. */
  rev?: string;
  updated_at: string;
}

export function stateOf(
  row: Pick<SentenceCardRow, "card" | "last_rating" | "updated_at">,
): SentenceState | null {
  const c = parseSentenceCard(row.card);
  if (!c) return null;
  return {
    due: c.due.toISOString(),
    stability: c.stability,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as 0 | 1 | 2 | 3,
    lastRating: Math.min(4, Math.max(1, row.last_rating)) as ReadRating,
    lastAt: row.updated_at,
  };
}

/**
 * Cards matched to the book's current sentences (flat index → row). A card
 * whose text key no longer matches its sentence (a segmenter update moved the
 * cuts) is matched to the sentence of the same line with that text, else
 * left out.
 */
export function matchCards(
  b: BookSentences,
  lines: readonly string[],
  rows: readonly SentenceCardRow[],
): Map<number, SentenceCardRow> {
  const out = new Map<number, SentenceCardRow>();
  const keyAt = (i: number) => {
    const l = b.refs[i * 4];
    return textKey(lines[l].slice(b.refs[i * 4 + 2], b.refs[i * 4 + 3]));
  };
  const stray: SentenceCardRow[] = [];
  for (const r of rows) {
    if (r.line < 0 || r.line >= lines.length) continue;
    const i = b.lineStart[r.line] + r.idx;
    if (r.idx >= 0 && i < b.lineStart[r.line + 1] && keyAt(i) === r.text_key) out.set(i, r);
    else stray.push(r);
  }
  for (const r of stray) {
    for (let i = b.lineStart[r.line]; i < b.lineStart[r.line + 1]; i++) {
      if (!out.has(i) && keyAt(i) === r.text_key) {
        out.set(i, r);
        break;
      }
    }
  }
  return out;
}
