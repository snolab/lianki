// Server side of a book's word progress (lib/read/words.ts): the stored word
// count of a material (backfilled once for books imported before it existed),
// and the signed-in reader's word cards, read in one query per request.

import type { D1Like } from "@/lib/d1/types";
import {
  getReadMaterialContent,
  markReadMaterialPassed,
  replaceReadMaterialContent,
  type ReadMaterial,
} from "@/lib/getReadMaterialsCollection";
import { PROGRESS_SCALE_DAYS } from "@/lib/words/progress";
import { parseBookMeta, type BookMeta } from "./book";
import { hasLemmas, LEMMA_V } from "./lemma";
import { lemmasForWords } from "./lemma-server";
import {
  BOOK_PASS_COVERAGE,
  bookPassed,
  bookProgress,
  cardIndex,
  countWords,
  coveragePercent,
  statsLemmas,
  type BookProgress,
  type CardRow,
  type WordStats,
} from "./words";

export interface MaterialWords {
  book: BookMeta | null;
  /** Plain-text content, when the material is not a book. */
  text?: string;
  stats: WordStats;
}

/**
 * A material's word count. A book keeps it in its meta (counted at import);
 * a book from before that is counted now and saved back, once. Pasted text
 * is counted on each read: it has no meta to keep it in, and is short.
 */
export async function materialWords(m: ReadMaterial, userId: string): Promise<MaterialWords> {
  const content = await getReadMaterialContent(m);
  const book = parseBookMeta(content);
  if (!book) return { book: null, text: content, stats: await withLex(countWords(m.lines)) };
  if (book.words && (!hasLemmas(book.words.lang) || book.words.lex?.v === LEMMA_V))
    return { book, stats: book.words };
  const base = book.words ?? countWords(m.lines, book.lang);
  const stats = await withLex(base);
  // The lemma file could not be read: nothing new to save; tried again next time.
  if (book.words && stats === base) return { book, stats };
  const next: BookMeta = { ...book, words: stats };
  try {
    await replaceReadMaterialContent(userId, String(m._id), JSON.stringify(next));
  } catch (err) {
    console.error("read: word-count backfill failed", err);
  }
  return { book: next, stats };
}

const LEX_CACHE_MAX = 64;
const lexCache = new Map<string, NonNullable<WordStats["lex"]>>();

/**
 * The stats with the dictionary entries their words need (lib/read/lemma.ts),
 * for a language with a lemma file; unchanged when the file cannot be read.
 */
export async function withLex(stats: WordStats): Promise<WordStats> {
  if (!hasLemmas(stats.lang) || stats.lex?.v === LEMMA_V) return stats;
  // Pasted text has no meta to store its entries in: keep the last few per
  // isolate, keyed by its exact words, so a listing does not parse again.
  const key = `${stats.lang}\n${stats.words.map((e) => e[0]).join(" ")}`;
  const hit = lexCache.get(key);
  if (hit) return { ...stats, lex: hit };
  try {
    const lem = await lemmasForWords(
      stats.lang,
      stats.words.map((e) => e[0]),
    );
    if (!lem) return stats;
    const lex = lem.toLex();
    lexCache.set(key, lex);
    if (lexCache.size > LEX_CACHE_MAX) lexCache.delete(lexCache.keys().next().value!);
    return { ...stats, lex };
  } catch (err) {
    console.error("read: lemma lookup failed", err);
    return stats;
  }
}

/** SQL for "this list's language is one of `langs`" ("und" matches every list). */
function langClause(langs: string[]): { sql: string; args: string[] } {
  const ls = [...new Set(langs)];
  if (!ls.length || ls.includes("und")) return { sql: "", args: [] };
  const parts: string[] = [];
  const args: string[] = [];
  for (const l of ls) {
    parts.push("(lower(l.lang) = ? OR lower(l.lang) LIKE ?)");
    args.push(l, `${l}-%`);
  }
  return { sql: ` AND (${parts.join(" OR ")})`, args };
}

/**
 * Every word card the reader has in these languages, across all of their
 * word lists: one query, scoped to their email.
 */
export async function userWordCards(
  db: D1Like,
  email: string,
  langs: string[],
): Promise<CardRow[]> {
  const { sql, args } = langClause(langs);
  const { results } = await db
    .prepare(
      `SELECT c.term AS term, c.reading AS reading, l.lang AS lang,
         json_extract(c.card, '$.stability') AS stability,
         json_extract(c.card, '$.scheduled_days') AS interval,
         MIN(${PROGRESS_SCALE_DAYS}, COALESCE(json_extract(l.params, '$.maxIntervalDays'), ${PROGRESS_SCALE_DAYS})) AS cap
       FROM word_cards c JOIN word_lists l ON l.email = c.email AND l.id = c.list_id
       WHERE c.email = ?${sql}`,
    )
    .bind(email, ...args)
    .all<CardRow>();
  return results.map((r) => ({ ...r, lang: r.lang.toLowerCase().split(/[-_]/)[0] }));
}

/** The words of the reader's own imported lists (Anki decks) in this language. */
export async function userDeckTerms(
  db: D1Like,
  email: string,
  lang: string,
): Promise<{ term: string; reading: string | null }[]> {
  const { sql, args } = langClause([lang]);
  const { results } = await db
    .prepare(
      `SELECT e.term AS term, e.reading AS reading
       FROM word_list_entries e JOIN word_lists l ON l.email = e.email AND l.id = e.list_id
       WHERE e.email = ?${sql}`,
    )
    .bind(email, ...args)
    .all<{ term: string; reading: string | null }>();
  return results;
}

/** What the list and the reader's header show for a material's words. */
export interface WordsSummary {
  lang: string;
  tokens: number;
  distinct: number;
  /** Null when the reader's cards could not be read (no D1, no email). */
  progress: BookProgress | null;
  /** Running words known, 0–100 (lib/read/words.ts COVERAGE): the ring. */
  coverage: number | null;
  /** The pass mark, 0–100. */
  passAt: number;
  /** Passes now. */
  passed: boolean;
  /** When it first passed (ISO), kept even if the coverage drops again. */
  passedAt: string | null;
}

/**
 * Summaries for several materials: one card query for all of them (the
 * languages they are in), then each book is matched in memory.
 */
export async function summarize(
  db: D1Like | null,
  email: string | null | undefined,
  all: WordStats[],
): Promise<WordsSummary[]> {
  let rows: CardRow[] | null = null;
  if (db && email && all.length)
    rows = await userWordCards(
      db,
      email,
      all.map((s) => s.lang),
    );
  return all.map((s) => {
    const mine = rows?.filter((r) => s.lang === "und" || r.lang === s.lang) ?? null;
    const progress = mine ? bookProgress(s, cardIndex(mine), statsLemmas(s)) : null;
    return {
      lang: s.lang,
      tokens: s.tokens,
      distinct: s.distinct,
      progress,
      coverage: progress ? coveragePercent(progress, s) : null,
      passAt: Math.round(BOOK_PASS_COVERAGE * 100),
      passed: progress ? bookPassed(progress, s) : false,
      passedAt: null,
    };
  });
}

/** A summary without the reader's cards (they could not be read). */
export function bareSummary(s: WordStats): WordsSummary {
  return {
    lang: s.lang,
    tokens: s.tokens,
    distinct: s.distinct,
    progress: null,
    coverage: null,
    passAt: Math.round(BOOK_PASS_COVERAGE * 100),
    passed: false,
    passedAt: null,
  };
}

/**
 * Summaries for the reader's own materials, with the first pass recorded
 * (once, never overwritten) when one passes now for the first time.
 */
export async function summarizeMaterials(
  db: D1Like | null,
  user: { id: string; email?: string | null },
  items: { material: Pick<ReadMaterial, "_id" | "passedAt">; stats: WordStats }[],
): Promise<WordsSummary[]> {
  let out: WordsSummary[];
  try {
    out = await summarize(
      db,
      user.email,
      items.map((i) => i.stats),
    );
  } catch (err) {
    console.error("read: word progress failed", err);
    out = items.map((i) => bareSummary(i.stats));
  }
  await Promise.all(
    out.map(async (sum, i) => {
      const m = items[i].material;
      let at = m.passedAt ?? null;
      if (!at && sum.passed) {
        try {
          at = await markReadMaterialPassed(user.id, String(m._id), new Date());
        } catch (err) {
          console.error("read: recording the pass failed", err);
        }
      }
      sum.passedAt = at ? at.toISOString() : null;
    }),
  );
  return out;
}
