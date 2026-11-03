// D1 side of reader v2 (docs/books-plan.md, "Review units";
// db/migrations/0030_reader_v2.sql). Every function takes the signed-in
// user's id and every statement filters on it: no row of another user is ever
// read or written. Callers have already checked that the material is theirs.
//
// Many rows in one statement go through json_each(?), so a grade or an
// exposure batch costs a few queries however many sentences it holds.

import type { D1Like } from "@/lib/d1/types";
import type {
  ExposureEvent,
  ExposureKind,
  Granularity,
  ProgressPut,
  ProgressResponse,
  ReadNote,
  ReadRating,
  ReadReview,
} from "./reader-api";
import { gradeSentence, parseSentenceCard, type SentenceCardRow } from "./sentence-cards";

/** D1 with batch (one transaction); the test database has it too. */
export type D1Batch = D1Like & {
  batch(statements: ReturnType<D1Like["prepare"]>[]): Promise<unknown>;
};

/** The book a request is about. */
export interface BookRef {
  userId: string;
  materialId: string;
  bookHash: string;
  lang: string;
}

/**
 * Rows per json_each statement: keeps each bound JSON well under D1's 2 MB
 * value limit (a card row is a few hundred bytes).
 */
export const ROWS_PER_STATEMENT = 500;

export function chunks<T>(rows: T[], n = ROWS_PER_STATEMENT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

// ── sentence cards ──────────────────────────────────────────────────────────

const CARD_COLS = "sid, line, idx, text_key, card, due, last_rating, rev, updated_at";

export async function cardsInLines(
  db: D1Like,
  userId: string,
  bookHash: string,
  from: number,
  to: number,
): Promise<SentenceCardRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${CARD_COLS} FROM read_sentence_cards
       WHERE user_id = ? AND book_hash = ? AND line >= ? AND line < ?`,
    )
    .bind(userId, bookHash, from, to)
    .all<SentenceCardRow>();
  return results;
}

export async function cardsOfBook(
  db: D1Like,
  userId: string,
  bookHash: string,
): Promise<SentenceCardRow[]> {
  const { results } = await db
    .prepare(`SELECT ${CARD_COLS} FROM read_sentence_cards WHERE user_id = ? AND book_hash = ?`)
    .bind(userId, bookHash)
    .all<SentenceCardRow>();
  return results;
}

/** A sentence being graded: its id, place and text key. */
export interface GradeTarget {
  sid: string;
  line: number;
  idx: number;
  textKey: string;
}

export interface GradeInput {
  targets: GradeTarget[];
  rating: ReadRating;
  granularity: Granularity;
  words: number;
  dwellMs: number | null;
  reviewId: string;
  now: Date;
  /** A note written with this read: saved in the same transaction. */
  note?: string;
  fuzz?: boolean;
}

/** Tries when another grade changed the same sentences in between. */
const GRADE_TRIES = 3;

/**
 * Grade an item: one FSRS step per sentence, one review row, and the note if
 * any, in one transaction. A review id seen before (a retry) changes nothing:
 * `duplicate` is true, and the cards and note are as stored. A concurrent
 * grade of the same sentences makes the transaction fail its staleness check
 * (the review row's `count` CHECK) and it is computed again from the new state.
 */
export async function gradeItem(
  db: D1Batch,
  ref: BookRef,
  g: GradeInput,
): Promise<{ duplicate: boolean; rows: SentenceCardRow[]; note: ReadNote | null }> {
  const sids = g.targets.map((t) => t.sid);
  const done = async (duplicate: boolean) => ({
    duplicate,
    rows: await cardsBySid(db, ref.userId, sids),
    note: await noteOfReview(db, ref.userId, g.reviewId),
  });
  if (await reviewExists(db, ref.userId, g.reviewId)) return done(true);
  for (let attempt = 1; ; attempt++) {
    try {
      await db.batch(await gradeStatements(db, ref, g, sids));
      return done(false);
    } catch (err) {
      const msg = String(err);
      if (/UNIQUE|PRIMARY KEY/i.test(msg)) return done(true);
      if (/CHECK/i.test(msg) && attempt < GRADE_TRIES) continue;
      throw err;
    }
  }
}

async function gradeStatements(db: D1Batch, ref: BookRef, g: GradeInput, sids: string[]) {
  const before = new Map((await cardsBySid(db, ref.userId, sids)).map((r) => [r.sid, r]));
  const at = g.now.toISOString();
  const next = g.targets.map((t) => {
    const card = gradeSentence(parseSentenceCard(before.get(t.sid)?.card), g.rating, g.now, g.fuzz);
    return {
      sid: t.sid,
      line: t.line,
      idx: t.idx,
      key: t.textKey,
      card: JSON.stringify(card),
      due: card.due.toISOString(),
    };
  });
  // Which read last wrote each card ('' = none): another since → stale.
  const expect = g.targets.map((t) => ({ sid: t.sid, u: before.get(t.sid)?.rev ?? "" }));
  const first = g.targets[0];
  const last = g.targets[g.targets.length - 1];
  const lineFrom = Math.min(...g.targets.map((t) => t.line));
  const lineTo = Math.max(...g.targets.map((t) => t.line));
  const stmts = [
    // First: a retry with the same id fails here (primary key), and a stale
    // read writes count 0, which the CHECK refuses; either aborts the batch.
    db
      .prepare(
        `INSERT INTO read_reviews (id, user_id, material_id, book_hash, lang, granularity, rating,
           first_sid, last_sid, line_from, line_to, count, words, dwell_ms, at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
           CASE WHEN EXISTS (
             SELECT 1 FROM json_each(?16) AS j
             LEFT JOIN read_sentence_cards c
               ON c.user_id = ?2 AND c.sid = json_extract(j.value, '$.sid')
             WHERE COALESCE(c.rev, '') != json_extract(j.value, '$.u')
           ) THEN 0 ELSE ?12 END, ?13, ?14, ?15`,
      )
      .bind(
        g.reviewId,
        ref.userId,
        ref.materialId,
        ref.bookHash,
        ref.lang,
        g.granularity,
        g.rating,
        first.sid,
        last.sid,
        lineFrom,
        lineTo,
        g.targets.length,
        g.words,
        g.dwellMs,
        at,
        JSON.stringify(expect),
      ),
    ...chunks(next).map((part) =>
      db
        .prepare(
          `INSERT INTO read_sentence_cards
             (user_id, sid, book_hash, line, idx, text_key, card, due, last_rating, rev, updated_at)
           SELECT ?1, json_extract(j.value, '$.sid'), ?2, json_extract(j.value, '$.line'),
             json_extract(j.value, '$.idx'), json_extract(j.value, '$.key'),
             json_extract(j.value, '$.card'), json_extract(j.value, '$.due'), ?3, ?6, ?4
           FROM json_each(?5) AS j WHERE true
           ON CONFLICT (user_id, sid) DO UPDATE SET
             card = excluded.card, due = excluded.due, last_rating = excluded.last_rating,
             text_key = excluded.text_key, line = excluded.line, idx = excluded.idx,
             rev = excluded.rev, updated_at = excluded.updated_at`,
        )
        .bind(ref.userId, ref.bookHash, g.rating, at, JSON.stringify(part), g.reviewId),
    ),
  ];
  if (g.note) {
    stmts.push(
      noteInsert(
        db,
        ref,
        { first: first.sid, last: last.sid, lineFrom, lineTo, text: g.note, reviewId: g.reviewId },
        crypto.randomUUID(),
        at,
      ),
    );
  }
  return stmts;
}

async function cardsBySid(db: D1Like, userId: string, sids: string[]): Promise<SentenceCardRow[]> {
  if (!sids.length) return [];
  const { results } = await db
    .prepare(
      `SELECT ${CARD_COLS} FROM read_sentence_cards
       WHERE user_id = ? AND sid IN (SELECT value FROM json_each(?))`,
    )
    .bind(userId, JSON.stringify(sids))
    .all<SentenceCardRow>();
  return results;
}

/** The user's recent graded reads in a language with a reading time: the bounds' data. */
export async function readSamples(
  db: D1Like,
  userId: string,
  lang: string,
  limit = 200,
): Promise<{ words: number; dwellMs: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT words, dwell_ms AS dwellMs FROM read_reviews
       WHERE user_id = ? AND lang = ? AND dwell_ms > 0 AND words > 0
       ORDER BY at DESC LIMIT ?`,
    )
    .bind(userId, lang, limit)
    .all<{ words: number; dwellMs: number }>();
  return results;
}

type ReviewRow = {
  id: string;
  at: string;
  rating: number;
  granularity: Granularity;
  first_sid: string;
  last_sid: string;
  count: number;
  dwell_ms: number | null;
};

/** Reads that touch lines [from, to), oldest first. */
export async function reviewsInLines(
  db: D1Like,
  userId: string,
  bookHash: string,
  from: number,
  to: number,
): Promise<ReadReview[]> {
  const { results } = await db
    .prepare(
      `SELECT id, at, rating, granularity, first_sid, last_sid, count, dwell_ms FROM read_reviews
       WHERE user_id = ? AND book_hash = ? AND line_to >= ? AND line_from < ?
       ORDER BY at`,
    )
    .bind(userId, bookHash, from, to)
    .all<ReviewRow>();
  return results.map((r) => ({
    id: r.id,
    at: r.at,
    rating: r.rating as ReadRating,
    granularity: r.granularity,
    first: r.first_sid,
    last: r.last_sid,
    count: r.count,
    dwellMs: r.dwell_ms,
  }));
}

export async function reviewExists(db: D1Like, userId: string, id: string): Promise<boolean> {
  return !!(await db
    .prepare("SELECT 1 AS x FROM read_reviews WHERE user_id = ? AND id = ?")
    .bind(userId, id)
    .first());
}

/** Sentences due by `now`, in reading order, and the next due time after it. */
export async function dueSentences(
  db: D1Like,
  userId: string,
  bookHash: string,
  now: Date,
  limit = 500,
): Promise<{ rows: Pick<SentenceCardRow, "sid" | "line" | "idx" | "due">[]; next: string | null }> {
  const iso = now.toISOString();
  const { results } = await db
    .prepare(
      `SELECT sid, line, idx, due FROM read_sentence_cards
       WHERE user_id = ? AND book_hash = ? AND due <= ? ORDER BY line, idx LIMIT ?`,
    )
    .bind(userId, bookHash, iso, limit)
    .all<Pick<SentenceCardRow, "sid" | "line" | "idx" | "due">>();
  const next = await db
    .prepare(
      `SELECT MIN(due) AS d FROM read_sentence_cards WHERE user_id = ? AND book_hash = ? AND due > ?`,
    )
    .bind(userId, bookHash, iso)
    .first<{ d: string | null }>();
  return { rows: results, next: next?.d ?? null };
}

// ── progress ────────────────────────────────────────────────────────────────

type ProgressRow = {
  line: number;
  anchor_offset: number;
  anchor_at: string;
  high_line: number | null;
};

export async function getProgress(
  db: D1Like,
  userId: string,
  materialId: string,
): Promise<ProgressResponse> {
  const r = await db
    .prepare(
      "SELECT line, anchor_offset, anchor_at, high_line FROM read_progress WHERE user_id = ? AND material_id = ?",
    )
    .bind(userId, materialId)
    .first<ProgressRow>();
  return r
    ? {
        anchor: { line: r.line, offset: r.anchor_offset, at: r.anchor_at },
        highLine: r.high_line,
      }
    : { anchor: null, highLine: null };
}

/**
 * Save a position: the anchor when its client time is the newest seen, the
 * high-water line only upward. Returns the lines it moved over, for extraction.
 */
export async function putProgress(
  db: D1Like,
  userId: string,
  materialId: string,
  p: ProgressPut,
  now: Date,
): Promise<ProgressResponse> {
  const before = await getProgress(db, userId, materialId);
  await db
    .prepare(
      `INSERT INTO read_progress (user_id, material_id, line, anchor_offset, anchor_at, high_line, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, material_id) DO UPDATE SET
         line = CASE WHEN excluded.anchor_at >= read_progress.anchor_at THEN excluded.line ELSE read_progress.line END,
         anchor_offset = CASE WHEN excluded.anchor_at >= read_progress.anchor_at THEN excluded.anchor_offset ELSE read_progress.anchor_offset END,
         anchor_at = MAX(excluded.anchor_at, read_progress.anchor_at),
         high_line = CASE
           WHEN excluded.high_line IS NULL THEN read_progress.high_line
           WHEN read_progress.high_line IS NULL THEN excluded.high_line
           ELSE MAX(read_progress.high_line, excluded.high_line) END,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, materialId, p.line, p.offset, p.at, p.highLine ?? null, now.toISOString())
    .run();
  const after = await getProgress(db, userId, materialId);
  const was = before.highLine ?? -1;
  if (after.highLine !== null && after.highLine > was)
    after.advanced = [was + 1, after.highLine + 1];
  return after;
}

// ── exposures ───────────────────────────────────────────────────────────────

/** An event checked against the book, with its day and (for explicit kinds) normalised word. */
export interface ExposureRow {
  sid: string;
  kind: ExposureKind;
  word: string;
  day: string;
  at: string;
}

/**
 * Record exposure events: each (sentence, kind, word, day) once — a resend is
 * a duplicate. New "seen" events add 1 to each of the sentence's words' seen
 * count for the day; explicit ones to the word's explicit count. Never touches
 * word cards.
 */
export async function recordExposures(
  db: D1Batch,
  ref: BookRef,
  events: ExposureRow[],
  wordsOf: (sid: string) => string[],
): Promise<{ accepted: number; duplicates: number }> {
  if (!events.length) return { accepted: 0, duplicates: 0 };
  // Same event twice in one batch: once.
  const uniq = new Map<string, ExposureRow>();
  for (const e of events) uniq.set(`${e.sid}\n${e.kind}\n${e.word}\n${e.day}`, e);
  const list = [...uniq.values()];
  const { results: had } = await db
    .prepare(
      `SELECT e.sid AS sid, e.kind AS kind, e.word AS word, e.day AS day
       FROM read_exposure_events e JOIN json_each(?2) AS j
         ON e.sid = json_extract(j.value, '$.sid') AND e.kind = json_extract(j.value, '$.kind')
        AND e.word = json_extract(j.value, '$.word') AND e.day = json_extract(j.value, '$.day')
       WHERE e.user_id = ?1`,
    )
    .bind(ref.userId, JSON.stringify(list))
    .all<{ sid: string; kind: string; word: string; day: string }>();
  const old = new Set(had.map((e) => `${e.sid}\n${e.kind}\n${e.word}\n${e.day}`));
  const fresh = list.filter((e) => !old.has(`${e.sid}\n${e.kind}\n${e.word}\n${e.day}`));
  const duplicates = events.length - fresh.length;
  if (!fresh.length) return { accepted: 0, duplicates };

  // One row per (event, word). Counts are added only for events this batch
  // itself inserted (marked with its id), so a concurrent resend that also
  // found them fresh adds nothing.
  const batch = crypto.randomUUID();
  const perWord: {
    w: string;
    day: string;
    sid: string;
    kind: ExposureKind;
    ew: string;
    at: string;
  }[] = [];
  for (const e of fresh) {
    const ws = e.kind === "seen" ? [...new Set(wordsOf(e.sid))] : [e.word];
    for (const w of ws)
      perWord.push({ w, day: e.day, sid: e.sid, kind: e.kind, ew: e.word, at: e.at });
  }

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO read_exposure_events (user_id, book_hash, sid, kind, word, day, at, batch)
         SELECT ?1, ?2, json_extract(j.value, '$.sid'), json_extract(j.value, '$.kind'),
           json_extract(j.value, '$.word'), json_extract(j.value, '$.day'), json_extract(j.value, '$.at'), ?4
         FROM json_each(?3) AS j`,
      )
      .bind(ref.userId, ref.bookHash, JSON.stringify(fresh), batch),
    ...chunks(perWord).map((part) =>
      db
        .prepare(
          `INSERT INTO read_exposures (user_id, lang, word, day, seen, explicit, last_at, last_sid)
           SELECT ?1, ?2, w.word, w.day, SUM(w.seen), SUM(w.explicit), MAX(w.at), w.sid
           FROM (
             SELECT json_extract(j.value, '$.w') AS word, json_extract(j.value, '$.day') AS day,
               json_extract(j.value, '$.sid') AS sid, json_extract(j.value, '$.kind') AS kind,
               json_extract(j.value, '$.ew') AS ew, json_extract(j.value, '$.at') AS at,
               CASE WHEN json_extract(j.value, '$.kind') = 'seen' THEN 1 ELSE 0 END AS seen,
               CASE WHEN json_extract(j.value, '$.kind') = 'seen' THEN 0 ELSE 1 END AS explicit
             FROM json_each(?3) AS j
           ) AS w
           JOIN read_exposure_events e
             ON e.user_id = ?1 AND e.batch = ?4 AND e.sid = w.sid AND e.kind = w.kind
            AND e.word = w.ew AND e.day = w.day
           WHERE true
           GROUP BY w.word, w.day
           ON CONFLICT (user_id, lang, word, day) DO UPDATE SET
             seen = read_exposures.seen + excluded.seen,
             explicit = read_exposures.explicit + excluded.explicit,
             last_sid = CASE WHEN excluded.last_at >= read_exposures.last_at THEN excluded.last_sid ELSE read_exposures.last_sid END,
             last_at = MAX(read_exposures.last_at, excluded.last_at)`,
        )
        .bind(ref.userId, ref.lang, JSON.stringify(part), batch),
    ),
  ]);
  // What this request itself inserted (a concurrent resend may have won some).
  const mine = await db
    .prepare("SELECT COUNT(*) AS n FROM read_exposure_events WHERE user_id = ? AND batch = ?")
    .bind(ref.userId, batch)
    .first<{ n: number }>();
  const accepted = mine?.n ?? 0;
  return { accepted, duplicates: events.length - accepted };
}

/** When each of these words was last seen in context (for reordering reviews later). */
export async function lastSeen(
  db: D1Like,
  userId: string,
  lang: string,
  words: string[],
): Promise<Map<string, string>> {
  if (!words.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT word, MAX(last_at) AS at FROM read_exposures
       WHERE user_id = ? AND lang = ? AND seen > 0 AND word IN (SELECT value FROM json_each(?))
       GROUP BY word`,
    )
    .bind(userId, lang, JSON.stringify(words))
    .all<{ word: string; at: string }>();
  return new Map(results.map((r) => [r.word, r.at]));
}

/** Validate one client event; null when it is malformed. */
export function exposureRow(
  e: Partial<ExposureEvent> | null | undefined,
  now: Date,
  normWord: (w: string) => string | null,
): ExposureRow | null {
  if (!e || typeof e !== "object") return null;
  const kind = e.kind;
  if (kind !== "seen" && kind !== "lookup" && kind !== "select" && kind !== "note") return null;
  if (typeof e.sid !== "string") return null;
  let word = "";
  if (kind !== "seen") {
    if (typeof e.word !== "string" || e.word.length > 200) return null;
    word = normWord(e.word) ?? "";
    if (!word) return null;
  }
  // The client's time, kept within the last week and never in the future.
  let t = typeof e.at === "string" ? Date.parse(e.at) : NaN;
  const n = now.getTime();
  if (!Number.isFinite(t) || t > n || t < n - 7 * 86_400_000) t = n;
  const at = new Date(t).toISOString();
  return { sid: e.sid, kind, word, day: at.slice(0, 10), at };
}

// ── notes ───────────────────────────────────────────────────────────────────

type NoteRow = {
  id: string;
  first_sid: string;
  last_sid: string;
  review_id: string | null;
  text: string;
  history: string;
  created_at: string;
  updated_at: string;
};

function toNote(r: NoteRow): ReadNote {
  let history: ReadNote["history"] = [];
  try {
    const h = JSON.parse(r.history);
    if (Array.isArray(h)) history = h;
  } catch {
    // keep empty
  }
  return {
    id: r.id,
    first: r.first_sid,
    last: r.last_sid,
    reviewId: r.review_id,
    text: r.text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    history,
  };
}

const NOTE_COLS = "id, first_sid, last_sid, review_id, text, history, created_at, updated_at";
export const NOTE_MAX_CHARS = 10_000;

export interface NoteInput {
  first: string;
  last: string;
  lineFrom: number;
  lineTo: number;
  text: string;
  reviewId: string | null;
}

function noteInsert(db: D1Like, ref: BookRef, n: NoteInput, id: string, at: string) {
  return db
    .prepare(
      `INSERT INTO read_notes (id, user_id, book_hash, first_sid, last_sid, line_from, line_to,
         review_id, text, history, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    )
    .bind(
      id,
      ref.userId,
      ref.bookHash,
      n.first,
      n.last,
      n.lineFrom,
      n.lineTo,
      n.reviewId,
      n.text,
      at,
      at,
    );
}

export async function createNote(
  db: D1Like,
  ref: BookRef,
  n: NoteInput,
  now: Date,
): Promise<ReadNote> {
  const id = crypto.randomUUID();
  const at = now.toISOString();
  await noteInsert(db, ref, n, id, at).run();
  return {
    id,
    first: n.first,
    last: n.last,
    reviewId: n.reviewId,
    text: n.text,
    createdAt: at,
    updatedAt: at,
    history: [],
  };
}

/** The note written with a read, if any. */
export async function noteOfReview(
  db: D1Like,
  userId: string,
  reviewId: string,
): Promise<ReadNote | null> {
  const r = await db
    .prepare(
      `SELECT ${NOTE_COLS} FROM read_notes
       WHERE user_id = ? AND review_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    )
    .bind(userId, reviewId)
    .first<NoteRow>();
  return r ? toNote(r) : null;
}

export async function notesInLines(
  db: D1Like,
  userId: string,
  bookHash: string,
  from: number,
  to: number,
): Promise<ReadNote[]> {
  const { results } = await db
    .prepare(
      `SELECT ${NOTE_COLS} FROM read_notes
       WHERE user_id = ? AND book_hash = ? AND deleted_at IS NULL AND line_to >= ? AND line_from < ?
       ORDER BY created_at`,
    )
    .bind(userId, bookHash, from, to)
    .all<NoteRow>();
  return results.map(toNote);
}

/** Edit a note's text; the text it had goes to its history. Null when not the user's. */
export async function updateNote(
  db: D1Like,
  userId: string,
  bookHash: string,
  id: string,
  text: string,
  now: Date,
): Promise<ReadNote | null> {
  const r = await db
    .prepare(
      `SELECT ${NOTE_COLS} FROM read_notes WHERE id = ? AND user_id = ? AND book_hash = ? AND deleted_at IS NULL`,
    )
    .bind(id, userId, bookHash)
    .first<NoteRow>();
  if (!r) return null;
  const note = toNote(r);
  if (note.text === text) return note;
  const at = now.toISOString();
  const history = [...note.history, { text: note.text, at: note.updatedAt }];
  await db
    .prepare(
      "UPDATE read_notes SET text = ?, history = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    )
    .bind(text, JSON.stringify(history), at, id, userId)
    .run();
  return { ...note, text, history, updatedAt: at };
}

/** Soft delete. False when not the user's. */
export async function deleteNote(
  db: D1Like,
  userId: string,
  bookHash: string,
  id: string,
  now: Date,
): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM read_notes WHERE id = ? AND user_id = ? AND book_hash = ? AND deleted_at IS NULL",
    )
    .bind(id, userId, bookHash)
    .first();
  if (!r) return false;
  await db
    .prepare("UPDATE read_notes SET deleted_at = ? WHERE id = ? AND user_id = ?")
    .bind(now.toISOString(), id, userId)
    .run();
  return true;
}

// ── book hash and deletion ──────────────────────────────────────────────────

export async function saveContentHash(
  db: D1Like,
  userId: string,
  materialId: string,
  hash: string,
): Promise<void> {
  await db
    .prepare("UPDATE read_materials SET content_hash = ? WHERE id = ? AND user_id = ?")
    .bind(hash, materialId, userId)
    .run();
}

/**
 * A material is being deleted: its position goes, and, unless the user keeps
 * another copy of the same text, its sentence cards, reads, notes and exposure
 * events too. (Per-word daily exposure counts are the user's word log, not
 * the book's, and stay.)
 */
export async function deleteReaderRows(
  db: D1Batch,
  userId: string,
  materialId: string,
  bookHash: string | null,
): Promise<void> {
  const stmts = [
    db
      .prepare("DELETE FROM read_progress WHERE user_id = ? AND material_id = ?")
      .bind(userId, materialId),
  ];
  if (bookHash) {
    const other = await db
      .prepare(
        "SELECT 1 AS x FROM read_materials WHERE user_id = ? AND content_hash = ? AND id != ? LIMIT 1",
      )
      .bind(userId, bookHash, materialId)
      .first();
    if (!other) {
      for (const t of [
        "read_sentence_cards",
        "read_reviews",
        "read_notes",
        "read_exposure_events",
      ]) {
        stmts.push(
          db.prepare(`DELETE FROM ${t} WHERE user_id = ? AND book_hash = ?`).bind(userId, bookHash),
        );
      }
    }
  }
  await db.batch(stmts);
}
