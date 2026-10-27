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
  cards: number;
  due: number;
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

  async lists(now = new Date()): Promise<WordList[]> {
    const { results } = await this.db
      .prepare(
        `SELECT l.*,
           (SELECT COUNT(*) FROM word_cards c WHERE c.email = l.email AND c.list_id = l.id) AS cards,
           (SELECT COUNT(*) FROM word_cards c WHERE c.email = l.email AND c.list_id = l.id
              AND c.card_due <= ?) AS due
         FROM word_lists l WHERE l.email = ? ORDER BY l.created_at`,
      )
      .bind(now.toISOString(), this.email)
      .all<ListRow>();
    return results.map(toList);
  }

  async getList(id: string, now = new Date()): Promise<WordList | null> {
    return (await this.lists(now)).find((l) => l.id === id) ?? null;
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
        `INSERT INTO word_lists (email, id, name, lang, source, cursor, params, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
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
      )
      .run();
    return id;
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

    let newToday = list.new_day === day ? list.new_today : 0;
    let cursor = list.cursor;
    const at = now.toISOString();
    const statements: D1StmtLike[] = [];
    for (const r of reviews) {
      const s = state.get(r.term)!;
      if (!s.card) {
        newToday++;
        if (typeof r.newIndex === "number") cursor = Math.max(cursor, r.newIndex + 1);
      }
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
          `UPDATE word_lists SET cursor = ?, new_day = ?, new_today = ?, updated_at = ?
           WHERE email = ? AND id = ?`,
        )
        .bind(cursor, day, newToday, at, this.email, listId),
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
    }));
    return {
      cards,
      newRemaining: newRemaining({ new_day: day, new_today: newToday }, params, day),
    };
  }
}
