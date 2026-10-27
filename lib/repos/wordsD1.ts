import type { Card } from "ts-fsrs";
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import {
  newRemaining,
  normalizeParams,
  parseCard,
  reviewWord,
  type Rating,
  type WordListParams,
} from "@/lib/words/schedule";

/** A word list with its live counts. */
export type WordList = {
  id: string;
  name: string;
  lang: string;
  source: string | null;
  cursor: number;
  params: WordListParams;
  newDay: string | null;
  newToday: number;
  /** Words with a card (seen at least once). */
  cards: number;
  due: number;
  /** In (re)learning steps: seen recently, not yet on day-scale intervals. */
  learning: number;
  /** Next interval of a year or more. */
  mastered: number;
  createdAt: string;
};

/** A word that has been reviewed at least once. */
export type WordCard = {
  term: string;
  reading: string | null;
  back: string;
  due: string;
  state: number;
  reps: number;
  /** The ts-fsrs Card as stored (JSON), so a client can preview intervals. */
  card: string;
};

/** One rating from the client. `newIndex` marks a catalog word seen for the first time. */
export type WordReviewInput = {
  term: string;
  reading?: string | null;
  back?: string;
  rating: Rating;
  elapsedMs?: number | null;
  newIndex?: number | null;
};

type ListRow = {
  id: string;
  name: string;
  lang: string;
  source: string | null;
  cursor: number;
  params: string;
  new_day: string | null;
  new_today: number;
  created_at: string;
  cards?: number;
  due?: number;
  learning?: number;
  mastered?: number;
};

type CardRow = {
  term: string;
  reading: string | null;
  back: string;
  card: string;
  card_due: string;
  reps: number;
};

const toList = (r: ListRow): WordList => ({
  id: r.id,
  name: r.name,
  lang: r.lang,
  source: r.source,
  cursor: r.cursor,
  params: normalizeParams(safeJson(r.params)),
  newDay: r.new_day,
  newToday: r.new_today,
  cards: r.cards ?? 0,
  due: r.due ?? 0,
  learning: r.learning ?? 0,
  mastered: r.mastered ?? 0,
  createdAt: r.created_at,
});

const toCard = (r: CardRow): WordCard => {
  const c = parseCard(r.card);
  return {
    term: r.term,
    reading: r.reading,
    back: r.back,
    due: r.card_due,
    state: c?.state ?? 0,
    reps: r.reps,
    card: r.card,
  };
};

function safeJson(s: string | null): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/**
 * D1-backed word lists for one user. Separate from fsrs_notes on purpose — see
 * db/migrations/0006_words.sql.
 */
export class WordsD1Repo {
  constructor(
    private readonly db: D1Like,
    private readonly email: string,
  ) {}

  /** Lists with progress counts; `id` narrows the scan to one list. */
  private async query(now: Date, id?: string): Promise<WordList[]> {
    const { results } = await this.db
      .prepare(
        `SELECT l.*, s.cards, s.due, s.learning, s.mastered
         FROM word_lists l
         LEFT JOIN (
           SELECT c.list_id,
             COUNT(*) AS cards,
             SUM(c.card_due <= ?) AS due,
             -- ts-fsrs State: 1 Learning, 3 Relearning
             SUM(json_extract(c.card, '$.state') IN (1, 3)) AS learning,
             -- A year, or the list's own cap when that is shorter.
             SUM(json_extract(c.card, '$.scheduled_days') >=
                 MIN(365, COALESCE(json_extract(wl.params, '$.maxIntervalDays'), 365))) AS mastered
           FROM word_cards c JOIN word_lists wl ON wl.email = c.email AND wl.id = c.list_id
           WHERE c.email = ?${id ? " AND c.list_id = ?" : ""} GROUP BY c.list_id
         ) s ON s.list_id = l.id
         WHERE l.email = ?${id ? " AND l.id = ?" : ""}
         ORDER BY COALESCE(l.position, 1e9), l.created_at`,
      )
      .bind(
        ...(id
          ? [now.toISOString(), this.email, id, this.email, id]
          : [now.toISOString(), this.email, this.email]),
      )
      .all<ListRow>();
    return results.map(toList);
  }

  async lists(now = new Date()): Promise<WordList[]> {
    return this.query(now);
  }

  async getList(id: string, now = new Date()): Promise<WordList | null> {
    return (await this.query(now, id))[0] ?? null;
  }

  async createList(input: {
    name: string;
    lang: string;
    source?: string | null;
    params?: unknown;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO word_lists (email, id, name, lang, source, cursor, params, created_at, updated_at, position)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM word_lists WHERE email = ?))`,
      )
      .bind(
        this.email,
        id,
        input.name,
        input.lang,
        input.source ?? null,
        JSON.stringify(normalizeParams(input.params)),
        at,
        at,
        this.email,
      )
      .run();
    return id;
  }

  /** Save the user's order of lists: `ids` first to last; others keep theirs after. */
  async reorder(ids: string[]): Promise<void> {
    for (const [i, id] of ids.entries())
      await this.db
        .prepare("UPDATE word_lists SET position = ? WHERE email = ? AND id = ?")
        .bind(i, this.email, id)
        .run();
  }

  async updateParams(id: string, params: unknown): Promise<WordListParams> {
    const p = normalizeParams(params);
    await this.db
      .prepare("UPDATE word_lists SET params = ?, updated_at = ? WHERE email = ? AND id = ?")
      .bind(JSON.stringify(p), new Date().toISOString(), this.email, id)
      .run();
    return p;
  }

  async deleteList(id: string): Promise<void> {
    for (const table of ["word_reviews", "word_cards"]) {
      await this.db
        .prepare(`DELETE FROM ${table} WHERE email = ? AND list_id = ?`)
        .bind(this.email, id)
        .run();
    }
    await this.db
      .prepare("DELETE FROM word_lists WHERE email = ? AND id = ?")
      .bind(this.email, id)
      .run();
  }

  /** Words due by `now`, most overdue first. */
  async dueCards(listId: string, now = new Date(), limit = 200): Promise<WordCard[]> {
    const { results } = await this.db
      .prepare(
        `SELECT term, reading, back, card, card_due, reps FROM word_cards
         WHERE email = ? AND list_id = ? AND card_due <= ?
         ORDER BY card_due LIMIT ?`,
      )
      .bind(this.email, listId, now.toISOString(), limit)
      .all<CardRow>();
    return results.map(toCard);
  }

  /** Terms in this list that already have a card, so the client skips them as new. */
  async knownTerms(listId: string, terms: string[]): Promise<Set<string>> {
    const known = new Set<string>();
    // D1 caps bound parameters at 100 per statement.
    for (let i = 0; i < terms.length; i += 90) {
      const chunk = terms.slice(i, i + 90);
      const { results } = await this.db
        .prepare(
          `SELECT term FROM word_cards WHERE email = ? AND list_id = ?
           AND term IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(this.email, listId, ...chunk)
        .all<{ term: string }>();
      for (const r of results) known.add(r.term);
    }
    return known;
  }

  /**
   * Apply a screen's worth of ratings in order. The same word may appear more
   * than once (a learning step that came back within the session); each rating
   * builds on the previous one.
   */
  async review(
    listId: string,
    reviews: WordReviewInput[],
    day: string,
    now = new Date(),
    /**
     * The first catalog index the client has not yet introduced. The client
     * knows which new words it reordered or still holds; deriving this from
     * the highest index reviewed would skip the ones left behind.
     */
    nextCursor?: number | null,
  ): Promise<{ cards: WordCard[]; newRemaining: number } | null> {
    const list = await this.db
      .prepare("SELECT * FROM word_lists WHERE email = ? AND id = ?")
      .bind(this.email, listId)
      .first<ListRow>();
    if (!list) return null;
    const params = normalizeParams(safeJson(list.params));

    const terms = [...new Set(reviews.map((r) => r.term))];
    const existing = new Map<string, CardRow>();
    for (let i = 0; i < terms.length; i += 90) {
      const chunk = terms.slice(i, i + 90);
      const { results } = await this.db
        .prepare(
          `SELECT term, reading, back, card, card_due, reps FROM word_cards
           WHERE email = ? AND list_id = ? AND term IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(this.email, listId, ...chunk)
        .all<CardRow>();
      for (const r of results) existing.set(r.term, r);
    }

    const state = new Map<
      string,
      { card: Card | null; reading: string | null; back: string; reps: number }
    >();
    for (const t of terms) {
      const row = existing.get(t);
      state.set(t, {
        card: parseCard(row?.card),
        reading: row?.reading ?? null,
        back: row?.back ?? "",
        reps: row?.reps ?? 0,
      });
    }

    let introduced = 0;
    const at = now.toISOString();
    const statements: D1StmtLike[] = [];
    for (const r of reviews) {
      const s = state.get(r.term)!;
      if (!s.card) introduced++;
      const { card, prevState } = reviewWord(s.card, r.rating, now, params);
      s.card = card;
      s.reps++;
      if (r.reading != null && !s.reading) s.reading = r.reading;
      if (r.back && !s.back) s.back = r.back;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO word_reviews (email, list_id, term, rating, state, elapsed_ms, reviewed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(this.email, listId, r.term, r.rating, prevState, r.elapsedMs ?? null, at),
      );
    }
    for (const [term, s] of state) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO word_cards (email, list_id, term, reading, back, card, card_due, reps, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(email, list_id, term) DO UPDATE SET
               reading = excluded.reading, back = excluded.back, card = excluded.card,
               card_due = excluded.card_due, reps = excluded.reps, updated_at = excluded.updated_at`,
          )
          .bind(
            this.email,
            listId,
            term,
            s.reading,
            s.back,
            JSON.stringify(s.card),
            s.card!.due.toISOString(),
            s.reps,
            at,
          ),
      );
    }
    statements.push(
      this.db
        .prepare(
          // Relative updates: two screens submitted together must not overwrite
          // each other's counts.
          `UPDATE word_lists SET
             cursor = COALESCE(?, cursor),
             new_today = CASE WHEN new_day = ? THEN new_today + ? ELSE ? END,
             new_day = ?, updated_at = ?
           WHERE email = ? AND id = ?`,
        )
        .bind(nextCursor ?? null, day, introduced, introduced, day, at, this.email, listId),
    );
    // One round trip on D1; the D1Like test double may lack batch().
    const batch = (this.db as { batch?: (s: D1StmtLike[]) => Promise<unknown> }).batch;
    if (batch) await batch.call(this.db, statements);
    else for (const st of statements) await st.run();

    const cards = [...state].map(([term, s]) => ({
      term,
      reading: s.reading,
      back: s.back,
      due: s.card!.due.toISOString(),
      state: s.card!.state,
      reps: s.reps,
      card: JSON.stringify(s.card),
    }));
    const used = (list.new_day === day ? list.new_today : 0) + introduced;
    return { cards, newRemaining: newRemaining({ new_day: day, new_today: used }, params, day) };
  }
}
