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
  /**
   * A line of the stored book that holds this word, for the model's prompt when
   * it generates a shared gloss (lib/read/gloss-server.ts). Absent: no example.
   */
  exampleOf?: (word: string) => string | null;
  /**
   * Private speech (a /vibe doc): a phrase of it is the speaker's own words, so a
   * meaning generated for one stays on this card and out of the shared word_gloss.
   */
  privateText?: boolean;
  /**
   * A YouTube song (lib/yt-songs/card-clip.ts): the clip JSON of the line an
   * example came from, stored on the word's entry. Absent: not a song.
   */
  clipOf?: (ex: string) => string | null;
}

/** One word of the review: his card's list and term, or the book list's new word. */
export interface ScopeItem {
  w: string;
  listId: string;
  term: string;
  reading: string | null;
  back: string;
  ex: string | null;
  /** The example's song clip JSON (a YouTube song), or null. */
  clip: string | null;
  /** The stored ts-fsrs card JSON; null: no card yet (a new word). */
  card: string | null;
}

/**
 * Whether a range's review shows this card now: no card (a new word), a due
 * one, or one whose due cannot be read (shown rather than lost).
 */
export function isDueCard(card: string | null, now: Date): boolean {
  if (!card) return true;
  try {
    const due = new Date((JSON.parse(card) as { due?: string }).due ?? NaN).getTime();
    return !(due > now.getTime());
  } catch {
    return true;
  }
}

const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);

/** The example's song clip (a YouTube song's line), worked out on the server only. */
const clipOfEx = (book: BookCtx, ex: string | null | undefined) =>
  ex && book.clipOf ? book.clipOf(ex.slice(0, 1000)) : null;

/** Gives words without a meaning one where it can (lib/read/gloss-server.ts fillGlosses). */
export type Gloss = (words: RangeWord[]) => Promise<RangeWord[]>;

/** The words glossed in place: `need` picks the ones worth a lookup. */
async function glossIn<T extends { x: RangeWord }>(
  matched: T[],
  need: (m: T) => boolean,
  gloss: Gloss | undefined,
) {
  const ask = matched.filter(need).map((m) => m.x);
  if (!gloss || !ask.length) return;
  const got = new Map((await gloss(ask)).map((x) => [x.w, x]));
  for (const m of matched) m.x = got.get(m.x.w) ?? m.x;
}

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
  reps: number;
};

/** The full card rows of these (list, term) pairs. */
async function fullCards(db: D1Like, email: string, keys: { listId: string; term: string }[]) {
  const out = new Map<string, FullRow>();
  for (let i = 0; i < keys.length; i += 45) {
    const chunk = keys.slice(i, i + 45);
    const { results } = await db
      .prepare(
        `SELECT list_id, term, reading, back, card, reps FROM word_cards WHERE email = ? AND (${chunk
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
 *
 * A card not due yet is left out: graded Easy, a word stays away until its
 * due, here as on /words (owner, 2026-11-04 19:28 JST: "lorsque" graded Easy
 * came back in the paragraph's review the same evening).
 */
export async function scopeSession(
  db: D1Like,
  email: string,
  book: BookCtx,
  words: RangeWord[],
  gloss?: Gloss,
  now: Date = new Date(),
  /** A word with no card yet: what it may be shown with, before a swipe commits it. */
  previewGloss: Gloss | undefined = gloss,
): Promise<{ items: ScopeItem[]; lists: WordList[]; missing: string[] }> {
  const matched = await matchAll(db, email, book, words);
  const missing = matched.filter((m) => !m.hit).map((m) => m.x.w);
  const bookList = missing.length
    ? await ensureBookList(db, email, book.hash, book.title, book.lang)
    : ((await findBookList(db, email, book.hash))?.id ?? null);
  const rows = await fullCards(
    db,
    email,
    matched.flatMap((m) => (m.hit ? [{ listId: m.hit.listId, term: m.hit.term }] : [])),
  );
  const rowOf = (hit: DeckCard | null) => (hit ? rows.get(`${hit.listId}\u0000${hit.term}`) : null);
  // A meaning for each word that has none: a card made without one, and a new word
  // (a preview: only what costs nothing, the rest when a swipe commits it).
  await glossIn(matched, (m) => !!m.hit && !m.x.back && !rowOf(m.hit)?.back, gloss);
  await glossIn(matched, (m) => !m.hit && !m.x.back, previewGloss);
  const items: ScopeItem[] = [];
  const seen = new Set<string>();
  /** His cards that have no meaning yet, and the one found for them now. */
  const fill: { listId: string; term: string; back: string }[] = [];
  for (const { x, hit } of matched) {
    const r = rowOf(hit);
    const listId = r ? r.list_id : bookList!;
    const term = r ? r.term : newCardTerm(x.w, book.lang, x.term, book.lem);
    // Two forms of one word ("regarda", "regarde") are one card: listed once.
    const key = `${listId}\u0000${term}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const back = r?.back || (clip(x.back, 1000) ?? "");
    if (r && !r.back && back) fill.push({ listId, term, back });
    items.push({
      w: x.w,
      listId,
      term,
      reading: r ? r.reading : clip(x.reading, 200),
      back,
      ex: clip(x.ex, 1000),
      clip: clipOfEx(book, x.ex),
      card: r ? r.card : null,
    });
  }
  // Cards of the book's list whose entry did not land (a grade's entry call
  // lost): their entry now.
  if (bookList)
    await runAll(
      db,
      entryStatements(
        db,
        email,
        bookList,
        items
          .filter((it) => it.listId === bookList && it.card)
          .map((it) => ({
            term: it.term,
            reading: it.reading,
            back: it.back,
            ex: it.ex,
            clip: it.clip,
          })),
      ),
    );
  await runAll(db, backfillStatements(db, email, fill));
  const shown = items.filter((it) => isDueCard(it.card, now));
  const ids = new Set(shown.map((it) => it.listId));
  const lists = (await new WordsD1Repo(db, email).lists()).filter((l) => ids.has(l.id));
  return { items: shown, lists, missing };
}

/**
 * A meaning for cards made without one (and their entries): only where the
 * back is still empty, so a meaning he wrote or one written meanwhile stays.
 */
export function backfillStatements(
  db: D1Like,
  email: string,
  fill: { listId: string; term: string; back: string }[],
): D1StmtLike[] {
  const at = new Date().toISOString();
  return fill.flatMap((f) => [
    db
      .prepare(
        "UPDATE word_cards SET back = ?, updated_at = ? WHERE email = ? AND list_id = ? AND term = ? AND back = ''",
      )
      .bind(f.back, at, email, f.listId, f.term),
    db
      .prepare(
        "UPDATE word_list_entries SET back = ?, updated_at = ? WHERE email = ? AND list_id = ? AND key = ? AND back = ''",
      )
      .bind(f.back, at, email, f.listId, f.term),
  ]);
}

/**
 * Append words to the book's list (each once: its term is the entry's key),
 * only where the word's card is in this list: an entry without a card would
 * be a new word to /words, carded twice if another list got it first.
 */
export function entryStatements(
  db: D1Like,
  email: string,
  listId: string,
  entries: {
    term: string;
    reading: string | null;
    back: string;
    ex: string | null;
    /** A song line's clip JSON (lib/yt-songs/card-clip.ts), or none. */
    clip?: string | null;
  }[],
): D1StmtLike[] {
  const at = new Date().toISOString();
  return entries.flatMap((e) => [
    db
      .prepare(
        `INSERT OR IGNORE INTO word_list_entries
           (email, list_id, key, position, term, back, reading, ex, clip, updated_at)
         SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM word_list_entries
           WHERE email = ? AND list_id = ?), ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM word_cards WHERE email = ? AND list_id = ? AND term = ?)`,
      )
      .bind(
        email,
        listId,
        e.term,
        email,
        listId,
        e.term,
        e.back,
        e.reading,
        e.ex,
        e.clip ?? null,
        at,
        email,
        listId,
        e.term,
      ),
    // An entry made before its song's clip was kept: the clip joins it, only
    // where the example is this same line and no clip is there yet.
    ...(e.clip && e.ex
      ? [
          db
            .prepare(
              "UPDATE word_list_entries SET clip = ? WHERE email = ? AND list_id = ? AND key = ? AND clip IS NULL AND ex = ?",
            )
            .bind(e.clip, email, listId, e.term, e.ex),
        ]
      : []),
  ]);
}

async function runAll(db: D1Like, statements: D1StmtLike[]) {
  if (!statements.length) return;
  const batch = (db as { batch?: (s: D1StmtLike[]) => Promise<unknown> }).batch;
  if (batch) await batch.call(db, statements);
  else for (const st of statements) await st.run();
}

/** A word of a selection as the grade handle sees it: his card (any state) or none. */
export interface WordTarget {
  w: string;
  /** His card's list and term; null: no card in any of his lists. */
  listId: string | null;
  term: string | null;
  /** The stored ts-fsrs card JSON; null: no card. */
  card: string | null;
  reps: number;
}

/** What each word is now, nothing written and no meaning looked up (the handle's probe). */
export async function wordTargets(
  db: D1Like,
  email: string,
  book: BookCtx,
  words: RangeWord[],
): Promise<WordTarget[]> {
  const matched = await matchAll(db, email, book, words);
  const rows = await fullCards(
    db,
    email,
    matched.flatMap((m) => (m.hit ? [{ listId: m.hit.listId, term: m.hit.term }] : [])),
  );
  return matched.map(({ x, hit }) => {
    const r = hit ? rows.get(`${hit.listId}\u0000${hit.term}`) : undefined;
    return {
      w: x.w,
      listId: r ? r.list_id : null,
      term: r ? r.term : null,
      card: r ? r.card : null,
      reps: r?.reps ?? 0,
    };
  });
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
  gloss?: Gloss,
): Promise<{ listId: string | null; terms: string[] }> {
  const matched = await matchAll(db, email, book, words);
  await glossIn(matched, (m) => !m.hit && !m.x.back, gloss);
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
    clip: clipOfEx(book, x.ex),
  }));
  const statements = [
    // In the same transaction as a guard: a card made meanwhile under the
    // same term in any of his lists of this language (another tab, another
    // book) wins, and one already in this list keeps its progress.
    ...entries.map((e) =>
      db
        .prepare(
          `INSERT INTO word_cards (email, list_id, term, reading, back, card, card_due, reps, updated_at, prev_card)
           SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL
           WHERE NOT EXISTS (
             SELECT 1 FROM word_cards c JOIN word_lists l ON l.email = c.email AND l.id = c.list_id
             WHERE c.email = ? AND lower(c.term) = lower(?)
               AND (lower(l.lang) = ? OR lower(l.lang) LIKE ?))
           ON CONFLICT(email, list_id, term) DO NOTHING`,
        )
        .bind(
          email,
          listId,
          e.term,
          e.reading,
          e.back,
          json,
          card.due.toISOString(),
          at,
          email,
          e.term,
          book.lang,
          `${book.lang}-%`,
        ),
    ),
    // After the cards, in the same transaction: entries only for cards made here.
    ...entryStatements(db, email, listId, entries),
  ];
  await runAll(db, statements);
  // The terms whose card is this list's (a race lost to another list made none).
  const made = await fullCards(
    db,
    email,
    entries.map((e) => ({ listId, term: e.term })),
  );
  return {
    listId,
    terms: entries.map((e) => e.term).filter((t) => made.has(`${listId}\u0000${t}`)),
  };
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
      // After the cards: an entry goes only with its card (one graded
      // meanwhile keeps both).
      db
        .prepare(
          `DELETE FROM word_list_entries WHERE email = ? AND list_id = ? AND key IN (${g})
           AND NOT EXISTS (SELECT 1 FROM word_cards c WHERE c.email = word_list_entries.email
             AND c.list_id = word_list_entries.list_id AND c.term = word_list_entries.key)`,
        )
        .bind(email, list.id, ...gone),
    ]);
    n += gone.length;
  }
  return n;
}

/**
 * New words of the book's list graded in the review: once their card is
 * there, they join the list's entries (meaning and example).
 */
export async function addGradedEntries(
  db: D1Like,
  email: string,
  book: BookCtx,
  words: RangeWord[],
  /** The meaning of a card the grade just made, when it was shown without one. */
  gloss?: Gloss,
): Promise<number> {
  const list = await findBookList(db, email, book.hash);
  if (!list) return 0;
  const matched = await matchAll(db, email, book, words);
  // Only words whose card is in the book's own list (made by the grade): an
  // entry without a card would be a new word to /words, carded twice if
  // another list gets it first. Not synced yet: 0, and the device asks again.
  const own = matched.filter((m) => m.hit?.listId === list.id);
  await glossIn(own, (m) => !m.x.back, gloss);
  const entries = own.map(({ x, hit }) => ({
    term: hit!.term,
    reading: clip(x.reading, 200),
    back: clip(x.back, 1000) ?? "",
    ex: clip(x.ex, 1000),
    clip: clipOfEx(book, x.ex),
  }));
  await runAll(db, [
    ...entryStatements(db, email, list.id, entries),
    ...backfillStatements(
      db,
      email,
      entries.filter((e) => e.back).map((e) => ({ listId: list.id, term: e.term, back: e.back })),
    ),
  ]);
  return entries.length;
}
