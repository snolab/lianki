import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import type { ImportEntry } from "@/lib/words/anki";

/** An entry as the /words client reads it — the shape of a catalog file's entries. */
export type ListEntry = {
  term: string;
  back: string;
  reading?: string;
  ex?: string;
  exTr?: string;
};

export type SyncResult = {
  added: number;
  updated: number;
  unchanged: number;
  /** Entries whose term changed: their card and reviews moved with them. */
  renamed: number;
  /** Incoming entries left out: their term already belongs to another note. */
  duplicates: number;
};

type Row = {
  key: string;
  position: number;
  term: string;
  back: string;
  reading: string | null;
  ex: string | null;
  ex_tr: string | null;
};

/** Rows per json_each statement: one bound JSON parameter, far below D1's 1 MB value cap. */
const CHUNK = 500;

/**
 * Entries of imported word lists (db/migrations/0012_word_list_entries.sql).
 * Each statement binds a JSON array and reads it with json_each, so a 20 000
 * word deck is ~40 statements — within D1's 100 parameters per statement and
 * its per-request query budget.
 */
export class WordEntriesD1Repo {
  constructor(
    private readonly db: D1Like,
    private readonly email: string,
  ) {}

  async entries(listId: string): Promise<ListEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT term, back, reading, ex, ex_tr FROM word_list_entries
         WHERE email = ? AND list_id = ? ORDER BY position`,
      )
      .bind(this.email, listId)
      .all<Row>();
    return results.map((r) => {
      const e: ListEntry = { term: r.term, back: r.back };
      if (r.reading) e.reading = r.reading;
      if (r.ex) e.ex = r.ex;
      if (r.ex_tr) e.exTr = r.ex_tr;
      return e;
    });
  }

  /**
   * Import or re-import: match by `key` (the Anki note guid). A known key
   * keeps its position and has its text updated — and if its term changed,
   * the word's card and review history follow the new term. A new key is
   * appended. Entries no longer in the deck are kept: the cursor counts
   * positions, and their reviews stay.
   */
  async sync(listId: string, incoming: ImportEntry[], now = new Date()): Promise<SyncResult> {
    const { results: existing } = await this.db
      .prepare(
        `SELECT key, position, term, back, reading, ex, ex_tr FROM word_list_entries
         WHERE email = ? AND list_id = ?`,
      )
      .bind(this.email, listId)
      .all<Row>();
    const byKey = new Map(existing.map((r) => [r.key, r]));
    const incomingKeys = new Set(incoming.map((e) => e.key));
    // Terms held by entries this import does not touch.
    const owner = new Map<string, string>();
    for (const r of existing) if (!incomingKeys.has(r.key)) owner.set(r.term, r.key);

    let next = existing.reduce((m, r) => Math.max(m, r.position + 1), 0);
    const out: SyncResult = { added: 0, updated: 0, unchanged: 0, renamed: 0, duplicates: 0 };
    const writes: (ImportEntry & { position: number })[] = [];
    const renames: [string, string][] = [];
    const seenKeys = new Set<string>();
    for (const e of incoming) {
      if (seenKeys.has(e.key) || (owner.has(e.term) && owner.get(e.term) !== e.key)) {
        out.duplicates++;
        continue;
      }
      seenKeys.add(e.key);
      owner.set(e.term, e.key);
      const old = byKey.get(e.key);
      if (!old) {
        out.added++;
        writes.push({ ...e, position: next++ });
        continue;
      }
      const same =
        old.term === e.term &&
        old.back === e.back &&
        (old.reading ?? undefined) === e.reading &&
        (old.ex ?? undefined) === e.ex &&
        (old.ex_tr ?? undefined) === e.exTr;
      if (same) {
        out.unchanged++;
        continue;
      }
      out.updated++;
      if (old.term !== e.term) renames.push([old.term, e.term]);
      writes.push({ ...e, position: old.position });
    }
    out.renamed = renames.length;

    const at = now.toISOString();
    const statements: D1StmtLike[] = [];
    for (let i = 0; i < renames.length; i += CHUNK) {
      const pairs = JSON.stringify(renames.slice(i, i + CHUNK));
      // Reviews first: they move only with a card that can move. OR IGNORE
      // leaves a card whose new term already has one where it is.
      statements.push(
        this.db
          .prepare(
            `UPDATE word_reviews SET term = (
               SELECT json_extract(value, '$[1]') FROM json_each(?1) WHERE json_extract(value, '$[0]') = word_reviews.term)
             WHERE email = ?2 AND list_id = ?3
               AND term IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))
               AND NOT EXISTS (SELECT 1 FROM word_cards c WHERE c.email = ?2 AND c.list_id = ?3
                 AND c.term = (SELECT json_extract(value, '$[1]') FROM json_each(?1)
                               WHERE json_extract(value, '$[0]') = word_reviews.term))`,
          )
          .bind(pairs, this.email, listId),
        this.db
          .prepare(
            `UPDATE OR IGNORE word_cards SET term = (
               SELECT json_extract(value, '$[1]') FROM json_each(?1) WHERE json_extract(value, '$[0]') = word_cards.term)
             WHERE email = ?2 AND list_id = ?3
               AND term IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))`,
          )
          .bind(pairs, this.email, listId),
      );
    }
    for (let i = 0; i < writes.length; i += CHUNK) {
      const rows = JSON.stringify(
        writes.slice(i, i + CHUNK).map((e) => ({
          k: e.key,
          p: e.position,
          t: e.term,
          b: e.back,
          r: e.reading ?? null,
          x: e.ex ?? null,
          y: e.exTr ?? null,
        })),
      );
      statements.push(
        this.db
          .prepare(
            `INSERT INTO word_list_entries (email, list_id, key, position, term, back, reading, ex, ex_tr, updated_at)
             SELECT ?1, ?2, json_extract(value, '$.k'), json_extract(value, '$.p'), json_extract(value, '$.t'),
               json_extract(value, '$.b'), json_extract(value, '$.r'), json_extract(value, '$.x'),
               json_extract(value, '$.y'), ?3
             FROM json_each(?4) WHERE true
             ON CONFLICT(email, list_id, key) DO UPDATE SET
               term = excluded.term, back = excluded.back, reading = excluded.reading,
               ex = excluded.ex, ex_tr = excluded.ex_tr, updated_at = excluded.updated_at`,
          )
          .bind(this.email, listId, at, rows),
        // A reviewed word carries its own copy of the back and reading.
        this.db
          .prepare(
            `UPDATE word_cards SET
               back = (SELECT json_extract(value, '$.b') FROM json_each(?3) WHERE json_extract(value, '$.t') = word_cards.term),
               reading = (SELECT json_extract(value, '$.r') FROM json_each(?3) WHERE json_extract(value, '$.t') = word_cards.term)
             WHERE email = ?1 AND list_id = ?2
               AND term IN (SELECT json_extract(value, '$.t') FROM json_each(?3))`,
          )
          .bind(this.email, listId, rows),
      );
    }
    statements.push(
      this.db
        .prepare("UPDATE word_lists SET updated_at = ? WHERE email = ? AND id = ?")
        .bind(at, this.email, listId),
    );
    const batch = (this.db as { batch?: (s: D1StmtLike[]) => Promise<unknown> }).batch;
    if (batch) await batch.call(this.db, statements);
    else for (const st of statements) await st.run();
    return out;
  }

  async deleteAll(listId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM word_list_entries WHERE email = ? AND list_id = ?")
      .bind(this.email, listId)
      .run();
  }
}
