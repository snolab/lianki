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
  // A meaning for each word that has none: a new word, or a card made without one.
  await glossIn(matched, (m) => !m.x.back && !rowOf(m.hit)?.back, gloss);
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
          .map((it) => ({ term: it.term, reading: it.reading, back: it.back, ex: it.ex })),
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
  entries: { term: string; reading: string | null; back: string; ex: string | null }[],
): D1StmtLike[] {
  const at = new Date().toISOString();
  return entries.map((e) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO word_list_entries
           (email, list_id, key, position, term, back, reading, ex, updated_at)
         SELECT ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM word_list_entries
           WHERE email = ? AND list_id = ?), ?, ?, ?, ?, ?
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
        at,
        email,
        listId,
        e.term,
      ),
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
): Promise<number> {
  const list = await findBookList(db, email, book.hash);
  if (!list) return 0;
  const matched = await matchAll(db, email, book, words);
  // Only words whose card is in the book's own list (made by the grade): an
  // entry without a card would be a new word to /words, carded twice if
  // another list gets it first. Not synced yet: 0, and the device asks again.
  const own = matched.filter((m) => m.hit?.listId === list.id);
  const entries = own.map(({ x, hit }) => ({
    term: hit!.term,
    reading: clip(x.reading, 200),
    back: clip(x.back, 1000) ?? "",
    ex: clip(x.ex, 1000),
  }));
  await runAll(db, entryStatements(db, email, list.id, entries));
  return entries.length;
}

// ── A paragraph graded Easy: its words graded Easy with it ───────────────
//
// Owner, 2026-11-05 02:31 JST (option A): an item graded Easy — by swipe on
// whichever side gives Easy, or by key — also grades Easy every word of the
// item that is due now on his card, and every word of the book he has no
// card for (made in the book's list, as 制卡, then graded). A card not due
// yet is never touched. The set is the item's words, as the paragraph word
// review takes them (rangeWords, own book words only; names without a card
// left out). Any other grade opens that review instead (ReaderV2), when this
// same plan finds at least one word. Sent with the paragraph's own grade
// once its Undo hold ends, so an undo inside the hold sends neither.

/** What an Easy paragraph grade would grade: the due cards and the words with no card. */
export interface EasyPlan {
  /** Due now on his best-matching card (one per card). */
  due: { w: string; listId: string; term: string }[];
  /** No card in any list of the book's language (one per new term). */
  fresh: RangeWord[];
}

/** The plan, from his cards as they are now (each due checked here, on the server). */
export async function easyPlan(
  db: D1Like,
  email: string,
  book: BookCtx,
  words: RangeWord[],
  now: Date = new Date(),
): Promise<EasyPlan> {
  const matched = await matchAll(db, email, book, words);
  const rows = await fullCards(
    db,
    email,
    matched.flatMap((m) => (m.hit ? [{ listId: m.hit.listId, term: m.hit.term }] : [])),
  );
  const due: EasyPlan["due"] = [];
  const fresh: RangeWord[] = [];
  const seen = new Set<string>();
  for (const { x, hit } of matched) {
    if (!hit) {
      const term = newCardTerm(x.w, book.lang, x.term, book.lem);
      if (seen.has(`\u0001${term}`)) continue;
      seen.add(`\u0001${term}`);
      fresh.push(x);
      continue;
    }
    const r = rows.get(`${hit.listId}\u0000${hit.term}`);
    if (!r) continue;
    const key = `${r.list_id}\u0000${r.term}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Only a card whose due reads and has come: an unreadable one is left alone.
    let at = NaN;
    try {
      at = new Date((JSON.parse(r.card) as { due?: string }).due ?? NaN).getTime();
    } catch {}
    if (Number.isFinite(at) && at <= now.getTime())
      due.push({ w: x.w, listId: r.list_id, term: r.term });
  }
  return { due, fresh };
}

/** The words an Easy grade would grade, by the book's word (the hint's count, the review's test). */
export const planWords = (p: EasyPlan) => [...p.due.map((d) => d.w), ...p.fresh.map((x) => x.w)];

/**
 * Grade the item's due and new words Easy (rating 4), through /words' own
 * review (WordsD1Repo.review): due cards per list in one call each; new
 * words get their card in the book's list first (makeCards, its guards),
 * then the same Easy. Safe to repeat: a word graded once is no longer due.
 */
export async function gradeEasyWords(
  db: D1Like,
  email: string,
  book: BookCtx,
  words: RangeWord[],
  day: string,
  now: Date = new Date(),
  gloss?: Gloss,
): Promise<{ graded: number; made: number }> {
  const plan = await easyPlan(db, email, book, words, now);
  const repo = new WordsD1Repo(db, email);
  const byList = new Map<string, string[]>();
  for (const d of plan.due) byList.set(d.listId, [...(byList.get(d.listId) ?? []), d.term]);
  let made = 0;
  if (plan.fresh.length) {
    const r = await makeCards(db, email, book, plan.fresh, now, gloss);
    made = r.terms.length;
    if (r.listId && r.terms.length)
      byList.set(r.listId, [...(byList.get(r.listId) ?? []), ...r.terms]);
  }
  let graded = 0;
  for (const [listId, terms] of byList) {
    const unique = [...new Set(terms)];
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const out = await repo.review(
        listId,
        chunk.map((term) => ({ term, rating: 4 as const })),
        day,
        now,
      );
      graded += out?.cards.length ?? 0;
    }
  }
  return { graded, made };
}
