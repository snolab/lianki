import type { FSRSNote } from "@/lib/core/fsrsNote";
import type { D1Like } from "@/lib/d1/types";
import { restoreNoteFromExport } from "@/lib/yaml-export";
import {
  compareHLC,
  DEFAULT_REVIEW_ORDER,
  newServerHLC,
  reviewOrderSql,
  type HLC,
  type ReviewOrder,
} from "@lianki/core";

/** A note as stored in D1 — carries the stable `id` (migrated MongoDB _id). */
export type StoredNote = FSRSNote & { id: string };

type Row = {
  id: string;
  email: string;
  url: string;
  title: string | null;
  card: string;
  log: string;
  notes: string | null;
  speed_markers: string | null;
  hlc: string | null;
  device_id: string | null;
  card_due: string;
};

/**
 * `card_due` of a note that has no card yet — e.g. one created only to hold
 * speed markers. Mongo stores such notes without `card`, which its due query
 * never matches; this sorts after every real date so `card_due <= now` never
 * does either, while the note still counts toward the total.
 */
export const CARDLESS_DUE = "9999-12-31T23:59:59.999Z";

function rowToNote(row: Row): StoredNote {
  const raw = {
    url: row.url,
    title: row.title ?? undefined,
    // Stored as JSON null when absent; surfaced as a missing field, like Mongo.
    card: JSON.parse(row.card) ?? undefined,
    log: JSON.parse(row.log || "[]"),
    notes: row.notes ?? undefined,
    speedMarkers: row.speed_markers ? JSON.parse(row.speed_markers) : undefined,
    hlc: row.hlc ? JSON.parse(row.hlc) : undefined,
    deviceId: row.device_id ?? undefined,
  };
  // restoreNoteFromExport converts ISO date strings back to Date objects
  // inside card / log, which the FSRS code expects.
  return { ...(restoreNoteFromExport(raw) as unknown as FSRSNote), id: row.id };
}

/** Columns the data table may sort on. Fixed allow-list — never user input. */
const SORT_COLUMNS = {
  due: "card_due",
  url: "url",
  title: "IFNULL(title, url)",
  reps: "CAST(json_extract(card, '$.reps') AS INTEGER)",
  lapses: "CAST(json_extract(card, '$.lapses') AS INTEGER)",
  state: "CAST(json_extract(card, '$.state') AS INTEGER)",
} as const;

export type NotesSort = keyof typeof SORT_COLUMNS;

export const NOTES_SORTS = Object.keys(SORT_COLUMNS) as NotesSort[];

export const NOTES_PAGE_MAX = 200;

export type NotesQueryOptions = {
  q?: string;
  /** ts-fsrs Card.state: 0 New, 1 Learning, 2 Review, 3 Relearning. */
  state?: number;
  due?: "all" | "due";
  sort?: NotesSort;
  order?: "asc" | "desc";
  page?: number;
  size?: number;
};

export function clampSize(size: number | undefined): number {
  if (!Number.isFinite(size) || (size ?? 0) < 1) return 50;
  return Math.min(NOTES_PAGE_MAX, Math.floor(size as number));
}

/** Neutralise LIKE wildcards in user input (paired with `ESCAPE '\\'`). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * D1-backed access to one user's FSRS notes (replaces MongoDB `FSRSNotes@{email}`).
 * Keyed by `email`, matching the per-email MongoDB collection model.
 */
/**
 * Appended to every read's WHERE clause.
 *
 * A tombstoned row still exists — that is the point — so every read has to
 * exclude it explicitly. Kept as one constant rather than spelled out per
 * query: a read that forgets it shows the user a card they deleted, which is
 * exactly the bug tombstones were added to fix.
 */
const LIVE = "deleted_at IS NULL";

/** The stored HLC, or null when the column is empty or malformed. */
function parseHlc(raw: string | null | undefined): HLC | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v?.timestamp === "number" ? (v as HLC) : null;
  } catch {
    return null;
  }
}

export class FsrsNotesD1Repo {
  constructor(
    private readonly db: D1Like,
    private readonly email: string,
  ) {}

  async getByUrl(url: string): Promise<StoredNote | null> {
    const row = await this.db
      .prepare(`SELECT * FROM fsrs_notes WHERE email = ? AND url = ? AND ${LIVE}`)
      .bind(this.email, url)
      .first<Row>();
    return row ? rowToNote(row) : null;
  }

  async getById(id: string): Promise<StoredNote | null> {
    const row = await this.db
      .prepare(`SELECT * FROM fsrs_notes WHERE email = ? AND id = ? AND ${LIVE}`)
      .bind(this.email, id)
      .first<Row>();
    return row ? rowToNote(row) : null;
  }

  async listAll(): Promise<StoredNote[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM fsrs_notes WHERE email = ? AND ${LIVE} ORDER BY card_due`)
      .bind(this.email)
      .all<Row>();
    return results.map(rowToNote);
  }

  /**
   * Cards already due, ordered by the user preference.
   *
   * The direction MUST be applied in SQL, not after fetching: callers take the
   * first N, so reversing in JS would hand back the N-th oldest rather than the
   * newest-due — the LIMIT has already discarded the other end.
   *
   * Safe to interpolate: reviewOrderSql only ever returns the literals ASC/DESC.
   */
  async listDue(
    now: Date,
    limit: number,
    order: ReviewOrder = DEFAULT_REVIEW_ORDER,
  ): Promise<StoredNote[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM fsrs_notes WHERE email = ? AND card_due <= ? AND ${LIVE}
          ORDER BY card_due ${reviewOrderSql(order)} LIMIT ?`,
      )
      .bind(this.email, now.toISOString(), limit)
      .all<Row>();
    return results.map(rowToNote);
  }

  async countAll(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM fsrs_notes WHERE email = ? AND ${LIVE}`)
      .bind(this.email)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  async countDue(now: Date): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM fsrs_notes WHERE email = ? AND card_due <= ? AND ${LIVE}`)
      .bind(this.email, now.toISOString())
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  /**
   * Insert or replace the note keyed by (email, url). Returns the note id.
   * Reuses an existing row's id, or the passed id, or a fresh UUID. The id
   * never changes on update (ON CONFLICT leaves it untouched).
   */
  async upsert(
    note: FSRSNote,
    id?: string,
    opts: {
      /**
       * Whether this write may revive a tombstoned url. False for an *add*:
       * merely opening a page must never undo a deletion, and `addNote` fires
       * on dialog-open carrying a fresh server HLC that would otherwise
       * outrank any tombstone. True (the default) for a review, which is a
       * deliberate act and the "last write wins" case the merge rules mean.
       */
      resurrect?: boolean;
    } = {},
  ): Promise<string> {
    const existing = await this.db
      .prepare("SELECT id, deleted_at, hlc FROM fsrs_notes WHERE email = ? AND url = ?")
      .bind(this.email, note.url)
      .first<{ id: string; deleted_at?: string | null; hlc?: string | null }>();
    const noteId = existing?.id ?? id ?? crypto.randomUUID();

    // A tombstone is a value that can win a merge, so an incoming live card
    // only resurrects the url when it is genuinely newer. Without this, every
    // client still holding a deleted card re-creates it on its next save —
    // which is the bug tombstones exist to fix, reintroduced one layer down.
    //
    // A write carrying no HLC cannot be compared, so it loses: `addNote` fires
    // on merely opening the dialog, and an unclocked write must not undo an
    // explicit deletion.
    if (existing?.deleted_at) {
      if (opts.resurrect === false) return noteId;
      if (!note.hlc) return noteId;
      const tombstone = parseHlc(existing.hlc);
      if (tombstone && compareHLC(note.hlc, tombstone) <= 0) return noteId;
    }
    const cardDue = note.card ? new Date(note.card.due).toISOString() : CARDLESS_DUE;
    await this.db
      .prepare(
        `INSERT INTO fsrs_notes
           (id, email, url, title, card, log, notes, speed_markers, hlc, device_id, card_due)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email, url) DO UPDATE SET
           title = excluded.title, card = excluded.card, log = excluded.log,
           notes = excluded.notes, speed_markers = excluded.speed_markers,
           hlc = excluded.hlc, device_id = excluded.device_id, card_due = excluded.card_due,
           deleted_at = NULL`,
      )
      .bind(
        noteId,
        this.email,
        note.url,
        note.title ?? null,
        JSON.stringify(note.card ?? null),
        JSON.stringify(note.log ?? []),
        note.notes ?? null,
        note.speedMarkers ? JSON.stringify(note.speedMarkers) : null,
        note.hlc ? JSON.stringify(note.hlc) : null,
        note.deviceId ?? null,
        cardDue,
      )
      .run();
    return noteId;
  }

  /**
   * Soft-delete: the row stays, carrying `deleted_at` and a fresh HLC so it can
   * out-rank a stale live copy arriving from another device. The card body is
   * cleared — a tombstone is a fact about a url, not a copy of what was there.
   */
  async delete(url: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE fsrs_notes
            SET deleted_at = ?, title = NULL, notes = NULL, speed_markers = NULL,
                log = '[]', hlc = ?
          WHERE email = ? AND url = ?`,
      )
      .bind(new Date().toISOString(), JSON.stringify(newServerHLC()), this.email, url)
      .run();
  }

  /**
   * Paged/filtered listing for the data-management table.
   *
   * Deliberately a repo method rather than a new query shape on
   * `D1FsrsCollection`: that shim only understands `card.due.$lte` and `url`,
   * so an unrecognised Mongo filter would be silently dropped and return every
   * row. Here the filter is SQL, and what is not expressed cannot be missed.
   *
   * `sort` is mapped through a fixed allow-list — never interpolated — so the
   * caller cannot reach the ORDER BY clause.
   */
  async query(opts: NotesQueryOptions): Promise<{ rows: StoredNote[]; total: number }> {
    // LIVE goes in with the first clause, not as an afterthought: this WHERE is
    // assembled from optional filters, and a tombstone leaking into the data
    // table is the user seeing a card they deleted.
    const where: string[] = ["email = ?", LIVE];
    const binds: unknown[] = [this.email];

    if (opts.q) {
      where.push("(url LIKE ? ESCAPE '\\' OR IFNULL(title, '') LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(opts.q)}%`;
      binds.push(like, like);
    }
    if (opts.state != null) {
      where.push("CAST(json_extract(card, '$.state') AS INTEGER) = ?");
      binds.push(opts.state);
    }
    if (opts.due === "due") {
      where.push("card_due <= ?");
      binds.push(new Date().toISOString());
    }

    const clause = `WHERE ${where.join(" AND ")}`;
    const orderBy = SORT_COLUMNS[opts.sort ?? "due"] ?? SORT_COLUMNS.due;
    const dir = opts.order === "desc" ? "DESC" : "ASC";
    const size = clampSize(opts.size);
    const offset = Math.max(0, opts.page ?? 0) * size;

    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM fsrs_notes ${clause}`)
      .bind(...binds)
      .first<{ c: number }>();

    const { results } = await this.db
      .prepare(`SELECT * FROM fsrs_notes ${clause} ORDER BY ${orderBy} ${dir} LIMIT ? OFFSET ?`)
      .bind(...binds, size, offset)
      .all<Row>();

    return { rows: results.map(rowToNote), total: totalRow?.c ?? 0 };
  }

  /**
   * Delete the given urls, returning how many rows actually went away.
   *
   * The count comes from a COUNT(*) taken before the DELETE rather than from
   * `run()`'s `meta.changes`: `D1StmtLike.run()` is typed `Promise<unknown>` and
   * the bun:sqlite test double returns an empty `meta`, so `changes` is not
   * something both backends can be held to.
   *
   * Chunked to stay well under D1's bound-parameter ceiling.
   */
  async deleteMany(urls: string[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < urls.length; i += 50) {
      const chunk = urls.slice(i, i + 50);
      const holes = chunk.map(() => "?").join(", ");
      const before = await this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM fsrs_notes WHERE email = ? AND url IN (${holes}) AND ${LIVE}`,
        )
        .bind(this.email, ...chunk)
        .first<{ c: number }>();
      await this.db
        .prepare(
          `UPDATE fsrs_notes
              SET deleted_at = ?, title = NULL, notes = NULL, speed_markers = NULL,
                  log = '[]', hlc = ?
            WHERE email = ? AND url IN (${holes}) AND ${LIVE}`,
        )
        .bind(new Date().toISOString(), JSON.stringify(newServerHLC()), this.email, ...chunk)
        .run();
      deleted += before?.c ?? 0;
    }
    return deleted;
  }

  /** Delete every note for this user. Unrecoverable. */
  async deleteAll(): Promise<number> {
    const before = await this.countAll();
    await this.db
      .prepare(
        `UPDATE fsrs_notes
            SET deleted_at = ?, title = NULL, notes = NULL, speed_markers = NULL,
                log = '[]', hlc = ?
          WHERE email = ? AND ${LIVE}`,
      )
      .bind(new Date().toISOString(), JSON.stringify(newServerHLC()), this.email)
      .run();
    return before;
  }

  /**
   * Hard-delete tombstones past the retention window.
   *
   * 90 days must be longer than any plausible offline period: it is the window
   * in which a returning device can still learn about a deletion cheaply. Past
   * it, a device needs the full-reconcile path instead — see
   * docs/sync-merge-rules.md. Sweeping earlier would resurrect cards on any
   * device that was away longer than the window.
   *
   * Returns how many rows were swept, so a caller can advance `purgedBefore`
   * only for work actually done.
   */
  async purgeTombstones(olderThan: Date): Promise<number> {
    const { results } = await this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM fsrs_notes
          WHERE email = ? AND deleted_at IS NOT NULL AND deleted_at < ?`,
      )
      .bind(this.email, olderThan.toISOString())
      .all<{ c: number }>();
    const n = results?.[0]?.c ?? 0;
    if (n > 0) {
      await this.db
        .prepare(
          `DELETE FROM fsrs_notes
            WHERE email = ? AND deleted_at IS NOT NULL AND deleted_at < ?`,
        )
        .bind(this.email, olderThan.toISOString())
        .run();
    }
    return n;
  }

  /** The tombstone for one url, or null when the url is live or absent. */
  async getTombstone(url: string): Promise<{ url: string; deletedAt: string } | null> {
    const row = await this.db
      .prepare(
        "SELECT url, deleted_at FROM fsrs_notes WHERE email = ? AND url = ? AND deleted_at IS NOT NULL",
      )
      .bind(this.email, url)
      .first<{ url: string; deleted_at: string }>();
    return row ? { url: row.url, deletedAt: row.deleted_at } : null;
  }

  /** Tombstones, for a client reconciling deletions. Live rows are excluded. */
  async listTombstones(): Promise<{ url: string; deletedAt: string; hlc: HLC | null }[]> {
    const { results } = await this.db
      .prepare(
        "SELECT url, deleted_at, hlc FROM fsrs_notes WHERE email = ? AND deleted_at IS NOT NULL",
      )
      .bind(this.email)
      .all<{ url: string; deleted_at: string; hlc?: string | null }>();
    return (results ?? []).map((r) => ({
      url: r.url,
      deletedAt: r.deleted_at,
      hlc: parseHlc(r.hlc),
    }));
  }

  async updateUrl(oldUrl: string, newUrl: string): Promise<void> {
    await this.db
      .prepare("UPDATE fsrs_notes SET url = ? WHERE email = ? AND url = ?")
      .bind(newUrl, this.email, oldUrl)
      .run();
  }
}
