// The server side of reviewing a range's words from the reader (the rules are
// in lib/read/word-review.ts). The review itself is /words' own list review
// (WordsClient Study), given these words instead of a list's session: each
// word on his existing card when any of his lists in the book's language has
// it — its FSRS state and schedule carried on — and otherwise as a new word
// of the book's own list ("book:<hash>": word_lists + word_list_entries, so
// /words studies it like an imported deck). Grades go through /words' own
// review endpoint. Every statement is scoped to his email.

import type { Card } from "ts-fsrs";
import { createEmptyCard } from "ts-fsrs";
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import { WordsD1Repo, type WordList } from "@/lib/repos/wordsD1";
import type { Lemmas } from "./lemma";
import { langClause } from "./progress";
import { bookListSource, deckIndex, matchCard, newCardTerm, type DeckCard } from "./word-review";

/** His cards in the book's language, light (no card JSON), for matching. */
export async function deckCards(db: D1Like, email: string, lang: string): Promise<DeckCard[]> {
  const { sql, args } = langClause([lang]);
  const { results } = await db
    .prepare(
      `SELECT c.list_id AS listId, l.name AS listName, c.term AS term, c.reading AS reading,
         json_extract(c.card, '$.last_review') AS lastReview, c.card_due AS due
       FROM word_cards c JOIN word_lists l ON l.email = c.email AND l.id = c.list_id
       WHERE c.email = ?${sql}`,
    )
    .bind(email, ...args)
    .all<DeckCard>();
  return results;
}

/** The book's own list, if it exists. */
export async function findBookList(db: D1Like, email: string, hash: string) {
  return db
    .prepare(
      "SELECT id, name FROM word_lists WHERE email = ? AND source = ? ORDER BY created_at, id LIMIT 1",
    )
    .bind(email, bookListSource(hash))
    .first<{ id: string; name: string }>();
}

/** The book's own list, made on first use (one statement: never two lists for one book). */
export async function ensureBookList(
  db: D1Like,
  email: string,
  hash: string,
  name: string,
  lang: string,
): Promise<string> {
  const source = bookListSource(hash);
  const at = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO word_lists (email, id, name, lang, source, cursor, params, created_at, updated_at, position)
       SELECT ?, ?, ?, ?, ?, 0, '{}', ?, ?,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM word_lists WHERE email = ?)
       WHERE NOT EXISTS (SELECT 1 FROM word_lists WHERE email = ? AND source = ?)`,
    )
    .bind(
      email,
      crypto.randomUUID(),
      name.slice(0, 200),
      lang,
      source,
      at,
      at,
      email,
      email,
      source,
    )
    .run();
  const row = await findBookList(db, email, hash);
  if (!row) throw new Error("book list not created");
  return row.id;
}

/** A word of the range, as the device sends it: its sentence, and a catalog meaning if it has one. */
export interface RangeWord {
  /** The book's word (normalised); the caller has checked it is one of the book's. */
  w: string;
  ex?: string | null;
  term?: string | null;
  reading?: string | null;
  back?: string | null;
}

export interface BookCtx {
  hash: string;
  title: string;
  lang: string;
  lem?: Lemmas | null;
  /** Names of the book (counted as known): never made into a card unless he has one. */
  names?: ReadonlySet<string>;
}

/** One word of the review: his card's list and term, or the book list's new word. */
export interface ScopeItem {
  w: string;
  listId: string;
  term: string;
  reading: string | null;
  back: string;
  ex: string | null;
  /** The stored ts-fsrs card JSON; null: no card yet (a new word). */
  card: string | null;
}

const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);

/** What each word of the range is: his existing card (best match), or nothing yet. */
async function matchAll(db: D1Like, email: string, book: BookCtx, words: RangeWord[]) {
  const idx = deckIndex(await deckCards(db, email, book.lang), book.lang);
  return words
    .map((x) => ({ x, hit: matchCard(x.w, book.lang, idx, book.lem) }))
    .filter((m) => m.hit || !book.names?.has(m.x.w));
}

type FullRow = {
  list_id: string;
  term: string;
  reading: string | null;
  back: string;
  card: string;
};

/** The full card rows of these (list, term) pairs. */
async function fullCards(db: D1Like, email: string, keys: { listId: string; term: string }[]) {
  const out = new Map<string, FullRow>();
  for (let i = 0; i < keys.length; i += 45) {
    const chunk = keys.slice(i, i + 45);
    const { results } = await db
      .prepare(
        `SELECT list_id, term, reading, back, card FROM word_cards WHERE email = ? AND (${chunk
          .map(() => "(list_id = ? AND term = ?)")
          .join(" OR ")})`,
      )
      .bind(email, ...chunk.flatMap((k) => [k.listId, k.term]))
      .all<FullRow>();
    for (const r of results) out.set(`${r.list_id}\u0000${r.term}`, r);
  }
  return out;
}

/**
 * The review of a range's words: the items for /words' list review, in the
 * order given, and the lists they belong to (for their FSRS parameters).
 * Words without a card come as new words of the book's list — the list is
 * made only when there is one (a book's list is never made empty).
 */
export async function scopeSession(
  db: D1Like,
  email: string,
  book: BookCtx,
  words: RangeWord[],
): Promise<{ items: ScopeItem[]; lists: WordList[]; missing: string[] }> {
  const matched = await matchAll(db, email, book, words);
  const missing = matched.filter((m) => !m.hit).map((m) => m.x.w);
  const bookList = missing.length
    ? await ensureBookList(db, email, book.hash, book.title, book.lang)
    : null;
  const rows = await fullCards(
    db,
    email,
    matched.flatMap((m) => (m.hit ? [{ listId: m.hit.listId, term: m.hit.term }] : [])),
  );
  const items: ScopeItem[] = [];
  const seen = new Set<string>();
  for (const { x, hit } of matched) {
    const r = hit ? rows.get(`${hit.listId}\u0000${hit.term}`) : null;
    const listId = r ? r.list_id : bookList!;
    const term = r ? r.term : newCardTerm(x.w, book.lang, x.term, book.lem);
    // Two forms of one word ("regarda", "regarde") are one card: listed once.
    const key = `${listId}\u0000${term}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      w: x.w,
      listId,
      term,
      reading: r ? r.reading : clip(x.reading, 200),
      back: r ? r.back : (clip(x.back, 1000) ?? ""),
      ex: clip(x.ex, 1000),
      card: r ? r.card : null,
    });
  }
  const ids = new Set(items.map((it) => it.listId));
  const lists = (await new WordsD1Repo(db, email).lists()).filter((l) => ids.has(l.id));
  return { items, lists, missing };
}

/** Append words to the book's list (each once: its term is the entry's key). */
export function entryStatements(
  db: D1Like,
  email: string,
  listId: string,
  entries: { term: string; reading: string | null; back: string; ex: string | null }[],
): D1StmtLike[] {
  const at = new Date().toISOString();
  return entries.map((e) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO word_list_entries
           (email, list_id, key, position, term, back, reading, ex, updated_at)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM word_list_entries
           WHERE email = ? AND list_id = ?), ?, ?, ?, ?, ?)`,
      )
      .bind(email, listId, e.term, email, listId, e.term, e.back, e.reading, e.ex, at),
  );
}

async function runAll(db: D1Like, statements: D1StmtLike[]) {
  if (!statements.length) return;
  const batch = (db as { batch?: (s: D1StmtLike[]) => Promise<unknown> }).batch;
  if (batch) await batch.call(db, statements);
  else for (const st of statements) await st.run();
}

/**
 * 制卡 (owner, 2026-11-03 22:27 JST): a card for every word of the range that
 * has none in any of his lists, in the book's list, unreviewed (a new FSRS
 * card, due now), with its catalog meaning and the range's sentence as its
 * example. Words with a card anywhere are left alone: never a second card.
 * Returns the terms made, for the toast's undo.
 */
export async function makeCards(
  db: D1Like,
  email: string,
  book: BookCtx,
  words: RangeWord[],
  now = new Date(),
): Promise<{ listId: string | null; terms: string[] }> {
  const matched = await matchAll(db, email, book, words);
  const missing = matched.filter((m) => !m.hit).map((m) => m.x);
  if (!missing.length) return { listId: null, terms: [] };
  const listId = await ensureBookList(db, email, book.hash, book.title, book.lang);
  const byTerm = new Map<string, RangeWord & { term: string }>();
  for (const x of missing) {
    const term = newCardTerm(x.w, book.lang, x.term, book.lem);
    if (!byTerm.has(term)) byTerm.set(term, { ...x, term });
  }
  const at = now.toISOString();
  const card: Card = createEmptyCard(now);
  const json = JSON.stringify(card);
  const entries = [...byTerm.values()].map((x) => ({
    term: x.term,
    reading: clip(x.reading, 200),
    back: clip(x.back, 1000) ?? "",
    ex: clip(x.ex, 1000),
  }));
  const statements = [
    ...entryStatements(db, email, listId, entries),
    // DO NOTHING: a card made meanwhile (another tab's grade) keeps its progress.
    ...entries.map((e) =>
      db
        .prepare(
          `INSERT INTO word_cards (email, list_id, term, reading, back, card, card_due, reps, updated_at, prev_card)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)
           ON CONFLICT(email, list_id, term) DO NOTHING`,
        )
        .bind(email, listId, e.term, e.reading, e.back, json, card.due.toISOString(), at),
    ),
  ];
  await runAll(db, statements);
  return { listId, terms: entries.map((e) => e.term) };
}

/**
 * Undo 制卡: the cards it made that are still unreviewed (reps 0), and their
 * entries. A card he has graded since stays, with its entry.
 */
export async function unmakeCards(
  db: D1Like,
  email: string,
  hash: string,
  terms: string[],
): Promise<number> {
  const list = await findBookList(db, email, hash);
  if (!list || !terms.length) return 0;
  let n = 0;
  for (let i = 0; i < terms.length; i += 90) {
    const chunk = terms.slice(i, i + 90);
    const marks = chunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT term FROM word_cards WHERE email = ? AND list_id = ? AND reps = 0 AND term IN (${marks})`,
      )
      .bind(email, list.id, ...chunk)
      .all<{ term: string }>();
    const gone = results.map((r) => r.term);
    if (!gone.length) continue;
    const g = gone.map(() => "?").join(",");
    await runAll(db, [
      db
        .prepare(
          `DELETE FROM word_cards WHERE email = ? AND list_id = ? AND reps = 0 AND term IN (${g})`,
        )
        .bind(email, list.id, ...gone),
      db
        .prepare(`DELETE FROM word_list_entries WHERE email = ? AND list_id = ? AND key IN (${g})`)
        .bind(email, list.id, ...gone),
    ]);
    n += gone.length;
  }
  return n;
}

/**
 * A new word of the book's list was graded in the review: it joins the
 * list's entries (its meaning and example), unless a card elsewhere has it.
 */
export async function addGradedEntries(
  db: D1Like,
  email: string,
  book: BookCtx,
  words: RangeWord[],
): Promise<number> {
  const list = await findBookList(db, email, book.hash);
  if (!list) return 0;
  const matched = await matchAll(db, email, book, words);
  // Matched in the book's own list (its card was just made by the grade) or nowhere.
  const own = matched.filter((m) => !m.hit || m.hit.listId === list.id);
  const entries = own.map(({ x, hit }) => ({
    term: hit?.term ?? newCardTerm(x.w, book.lang, x.term, book.lem),
    reading: clip(x.reading, 200),
    back: clip(x.back, 1000) ?? "",
    ex: clip(x.ex, 1000),
  }));
  await runAll(db, entryStatements(db, email, list.id, entries));
  return entries.length;
}
