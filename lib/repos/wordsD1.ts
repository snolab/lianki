import type { Card } from "ts-fsrs";
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import {
  reviewTime,
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
  /** Parent group's id, or null at the top level. */
  parentId: string | null;
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
  /** Words an imported list holds (word_list_entries); 0 for a catalog list. */
  size: number;
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
  /** When it was graded, if not now: a review made offline and synced later. */
  reviewedAt?: string | null;
};

type ListRow = {
  id: string;
  name: string;
  lang: string;
  source: string | null;
  parent_id?: string | null;
  cursor: number;
  params: string;
  new_day: string | null;
  new_today: number;
  created_at: string;
  cards?: number;
  due?: number;
  learning?: number;
  mastered?: number;
  size?: number;
};

type CardRow = {
  term: string;
  reading: string | null;
  back: string;
  card: string;
  card_due: string;
  reps: number;
  prev_card?: string | null;
};

const toList = (r: ListRow): WordList => ({
  id: r.id,
  name: r.name,
  lang: r.lang,
  source: r.source,
  parentId: r.parent_id ?? null,
  cursor: r.cursor,
  params: normalizeParams(safeJson(r.params)),
  newDay: r.new_day,
  newToday: r.new_today,
  cards: r.cards ?? 0,
  due: r.due ?? 0,
  learning: r.learning ?? 0,
  mastered: r.mastered ?? 0,
  size: r.size ?? 0,
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
    readonly db: D1Like,
    readonly email: string,
  ) {}

  /** Lists with progress counts; `id` narrows the scan to one list. */
  private async query(now: Date, id?: string): Promise<WordList[]> {
    const { results } = await this.db
      .prepare(
        `SELECT l.*, s.cards, s.due, s.learning, s.mastered,
           CASE WHEN l.source LIKE 'anki:%' THEN (SELECT COUNT(*) FROM word_list_entries e
             WHERE e.email = l.email AND e.list_id = l.id) ELSE 0 END AS size
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

  /**
   * Save the tree: `items` in display order, each with its parent (null = top
   * level). A parent must be one of this user's lists and must not be the item
   * itself or below it; anything else falls back to top level.
   */
  async reorder(items: { id: string; parentId?: string | null }[]): Promise<void> {
    const ids = new Set(items.map((x) => x.id));
    const parentOf = new Map(items.map((x) => [x.id, x.parentId ?? null]));
    const cycles = (id: string, parent: string | null) => {
      for (let p = parent, n = 0; p && n < 64; p = parentOf.get(p) ?? null, n++)
        if (p === id) return true;
      return false;
    };
    for (const [i, { id, parentId }] of items.entries()) {
      const parent = parentId && ids.has(parentId) && !cycles(id, parentId) ? parentId : null;
      await this.db
        .prepare("UPDATE word_lists SET position = ?, parent_id = ? WHERE email = ? AND id = ?")
        .bind(i, parent, this.email, id)
        .run();
    }
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
    // A deleted group's children move up to its own parent.
    await this.db
      .prepare(
        `UPDATE word_lists SET parent_id =
           (SELECT parent_id FROM word_lists WHERE email = ? AND id = ?)
         WHERE email = ? AND parent_id = ?`,
      )
      .bind(this.email, id, this.email, id)
      .run();
    for (const table of ["word_reviews", "word_cards", "word_list_entries"]) {
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

  /**
   * Due words for several lists in one query, most overdue first, and each
   * list's remaining new-word allowance. `more` is true when the limit was
   * reached, i.e. more due words are waiting.
   */
  async sessionMany(
    ids: string[],
    day: string,
    now = new Date(),
    limit = 400,
  ): Promise<{
    lists: Record<string, { due: WordCard[]; newRemaining: number }>;
    more: boolean;
  }> {
    const out: Record<string, { due: WordCard[]; newRemaining: number }> = {};
    if (!ids.length) return { lists: out, more: false };
    const marks = ids.map(() => "?").join(",");
    const { results: rows } = await this.db
      .prepare(`SELECT * FROM word_lists WHERE email = ? AND id IN (${marks})`)
      .bind(this.email, ...ids)
      .all<ListRow>();
    for (const r of rows)
      out[r.id] = {
        due: [],
        newRemaining: newRemaining(r, normalizeParams(safeJson(r.params)), day),
      };
    const { results } = await this.db
      .prepare(
        `SELECT list_id, term, reading, back, card, card_due, reps FROM word_cards
         WHERE email = ? AND list_id IN (${marks}) AND card_due <= ?
         ORDER BY card_due LIMIT ?`,
      )
      .bind(this.email, ...ids, now.toISOString(), limit)
      .all<CardRow & { list_id: string }>();
    for (const r of results) out[r.list_id]?.due.push(toCard(r));
    return { lists: out, more: results.length >= limit };
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

  private deleteLastReview(listId: string, term: string): D1StmtLike {
    return this.db
      .prepare(
        `DELETE FROM word_reviews WHERE rowid = (
           SELECT rowid FROM word_reviews WHERE email = ? AND list_id = ? AND term = ?
           ORDER BY rowid DESC LIMIT 1)`,
      )
      .bind(this.email, listId, term);
  }

  /**
   * Undo a word's latest review: back to the card it was before, or no card
   * at all if that was its first review. One level: returns null when there
   * is nothing kept to go back to.
   */
  async undo(listId: string, term: string, day: string): Promise<{ card: WordCard | null } | null> {
    const row = await this.db
      .prepare(
        `SELECT term, reading, back, card, card_due, reps, prev_card FROM word_cards
         WHERE email = ? AND list_id = ? AND term = ?`,
      )
      .bind(this.email, listId, term)
      .first<CardRow>();
    // "" marks a card already undone once: nothing further is kept.
    if (!row || row.prev_card === "") return null;
    if (row.prev_card) {
      const prev = parseCard(row.prev_card)!;
      await this.deleteLastReview(listId, term).run();
      await this.db
        .prepare(
          `UPDATE word_cards SET card = ?, card_due = ?, reps = ?, prev_card = '', updated_at = ?
           WHERE email = ? AND list_id = ? AND term = ?`,
        )
        .bind(
          row.prev_card,
          prev.due.toISOString(),
          Math.max(0, row.reps - 1),
          new Date().toISOString(),
          this.email,
          listId,
          term,
        )
        .run();
      return {
        card: toCard({
          ...row,
          card: row.prev_card,
          card_due: prev.due.toISOString(),
          reps: Math.max(0, row.reps - 1),
        }),
      };
    }
    if (row.reps <= 1) {
      // Its only review: the word goes back to never seen.
      await this.deleteLastReview(listId, term).run();
      await this.db
        .prepare("DELETE FROM word_cards WHERE email = ? AND list_id = ? AND term = ?")
        .bind(this.email, listId, term)
        .run();
      await this.db
        .prepare(
          `UPDATE word_lists SET new_today = MAX(0, new_today - 1)
           WHERE email = ? AND id = ? AND new_day = ?`,
        )
        .bind(this.email, listId, day)
        .run();
      return { card: null };
    }
    return null;
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
          `SELECT term, reading, back, card, card_due, reps, prev_card FROM word_cards
           WHERE email = ? AND list_id = ? AND term IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(this.email, listId, ...chunk)
        .all<CardRow>();
      for (const r of results) existing.set(r.term, r);
    }

    const state = new Map<
      string,
      {
        card: Card | null;
        /** JSON of the card before its latest review; null = none kept. */
        prev: string | null;
        reading: string | null;
        back: string;
        reps: number;
        /** Its latest review was undone: grading it is a fresh review. */
        undone: boolean;
      }
    >();
    for (const t of terms) {
      const row = existing.get(t);
      state.set(t, {
        card: parseCard(row?.card),
        prev: row?.prev_card || null, // "" (already undone) keeps nothing
        reading: row?.reading ?? null,
        back: row?.back ?? "",
        reps: row?.reps ?? 0,
        undone: row?.prev_card === "",
      });
    }

    let introduced = 0;
    const at = now.toISOString();
    const statements: D1StmtLike[] = [];
    for (const r of reviews) {
      const s = state.get(r.term)!;
      const when = reviewTime(r.reviewedAt, now);
      // Grading a word that is not due again yet re-grades its latest review
      // (it was just reviewed: a changed mind, not a new recall), replacing
      // that review. Grading a due word is a new review.
      const replace =
        !s.undone &&
        !!s.card &&
        s.card.due.getTime() > when.getTime() &&
        (s.prev !== null || s.reps === 1);
      let base: Card | null;
      if (replace) {
        base = parseCard(s.prev); // null: the word's first review is re-graded
        s.reps--;
        statements.push(this.deleteLastReview(listId, r.term));
      } else {
        if (!s.card) introduced++;
        base = s.card;
        s.prev = s.card ? JSON.stringify(s.card) : null;
      }
      s.undone = false;
      const { card, prevState } = reviewWord(base, r.rating, when, params);
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
          .bind(
            this.email,
            listId,
            r.term,
            r.rating,
            prevState,
            r.elapsedMs ?? null,
            when.toISOString(),
          ),
      );
    }
    for (const [term, s] of state) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO word_cards (email, list_id, term, reading, back, card, card_due, reps, updated_at, prev_card)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(email, list_id, term) DO UPDATE SET
               reading = excluded.reading, back = excluded.back, card = excluded.card,
               card_due = excluded.card_due, reps = excluded.reps, updated_at = excluded.updated_at,
               prev_card = excluded.prev_card`,
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
            s.prev,
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

  /** Store swipe telemetry (db/migrations/0010_swipe_log.sql). At most 200 per call. */
  async logSwipes(
    swipes: {
      at: string;
      finger: number;
      v: number;
      projected: number;
      rating: number | null;
      a: number;
      params?: string;
    }[],
  ): Promise<number> {
    const rows = swipes.slice(0, 200);
    const statements = rows.map((s) =>
      this.db
        .prepare(
          `INSERT INTO swipe_log (email, at, finger, v, projected, rating, a, params)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(this.email, s.at, s.finger, s.v, s.projected, s.rating, s.a, s.params ?? null),
    );
    const batch = (this.db as { batch?: (s: D1StmtLike[]) => Promise<unknown> }).batch;
    if (batch) await batch.call(this.db, statements);
    else for (const st of statements) await st.run();
    return rows.length;
  }
}
