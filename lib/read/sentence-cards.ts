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
import { stripFillers } from "./prep";
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

/**
 * A sentence's words only (no hesitation sounds; NFKC, lower case, letters,
 * marks and digits): the same through a re-cut or a polish.
 */
export function sentenceWordsKey(s: string): string {
  return stripFillers(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

/**
 * Old sentence → new sentence, for a text cut again (bite size) or polished
 * (punctuation, case and sentence ends changed, words not). When the whole
 * text's words are the same, each new sentence takes the old sentence its
 * first word was in (a raw run cut into three sentences gives each the
 * run's card). Otherwise (the text itself changed) each new sentence takes
 * the first unused old one after the last taken with the same words.
 * Returns [old line, old index, new line, new index, new text key].
 */
export function sentenceCarryMap(
  oldB: BookSentences,
  oldLines: readonly string[],
  newB: BookSentences,
  newLines: readonly string[],
): [number, number, number, number, string][] {
  const textOf = (b: BookSentences, lines: readonly string[], i: number) =>
    lines[b.refs[i * 4]].slice(b.refs[i * 4 + 2], b.refs[i * 4 + 3]);
  const oldKeys = Array.from({ length: oldB.n }, (_, i) =>
    sentenceWordsKey(textOf(oldB, oldLines, i)),
  );
  const newTexts = Array.from({ length: newB.n }, (_, j) => textOf(newB, newLines, j));
  const newKeys = newTexts.map(sentenceWordsKey);
  const out: [number, number, number, number, string][] = [];
  const push = (i: number, j: number) =>
    out.push([
      oldB.refs[i * 4],
      oldB.refs[i * 4 + 1],
      newB.refs[j * 4],
      newB.refs[j * 4 + 1],
      textKey(newTexts[j]),
    ]);

  if (oldB.n && oldKeys.join("") === newKeys.join("")) {
    let i = 0;
    let oldEnd = oldKeys[0].length;
    let at = 0;
    for (let j = 0; j < newB.n; j++) {
      if (!newKeys[j]) continue;
      while (i < oldB.n - 1 && at >= oldEnd) oldEnd += oldKeys[++i].length;
      push(i, j);
      at += newKeys[j].length;
    }
    return out;
  }

  const byKey = new Map<string, number[]>();
  oldKeys.forEach((k, i) => {
    if (!k) return;
    const q = byKey.get(k);
    if (q) q.push(i);
    else byKey.set(k, [i]);
  });
  let last = -1;
  for (let j = 0; j < newB.n; j++) {
    const i = byKey.get(newKeys[j])?.find((x) => x > last);
    if (i === undefined) continue;
    last = i;
    push(i, j);
  }
  return out;
}
