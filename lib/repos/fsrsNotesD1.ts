import type { FSRSNote } from "@/app/fsrs";
import type { D1Like } from "@/lib/d1/types";
import { restoreNoteFromExport } from "@/lib/yaml-export";

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

function rowToNote(row: Row): StoredNote {
  const raw = {
    url: row.url,
    title: row.title ?? undefined,
    card: JSON.parse(row.card),
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
export class FsrsNotesD1Repo {
  constructor(
    private readonly db: D1Like,
    private readonly email: string,
  ) {}

  async getByUrl(url: string): Promise<StoredNote | null> {
    const row = await this.db
      .prepare("SELECT * FROM fsrs_notes WHERE email = ? AND url = ?")
      .bind(this.email, url)
      .first<Row>();
    return row ? rowToNote(row) : null;
  }

  async getById(id: string): Promise<StoredNote | null> {
    const row = await this.db
      .prepare("SELECT * FROM fsrs_notes WHERE email = ? AND id = ?")
      .bind(this.email, id)
      .first<Row>();
    return row ? rowToNote(row) : null;
  }

  async listAll(): Promise<StoredNote[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM fsrs_notes WHERE email = ? ORDER BY card_due")
      .bind(this.email)
      .all<Row>();
    return results.map(rowToNote);
  }

  async listDue(now: Date, limit: number): Promise<StoredNote[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM fsrs_notes WHERE email = ? AND card_due <= ? ORDER BY card_due LIMIT ?",
      )
      .bind(this.email, now.toISOString(), limit)
      .all<Row>();
    return results.map(rowToNote);
  }

  async countAll(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS c FROM fsrs_notes WHERE email = ?")
      .bind(this.email)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  async countDue(now: Date): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS c FROM fsrs_notes WHERE email = ? AND card_due <= ?")
      .bind(this.email, now.toISOString())
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  /**
   * Insert or replace the note keyed by (email, url). Returns the note id.
   * Reuses an existing row's id, or the passed id, or a fresh UUID. The id
   * never changes on update (ON CONFLICT leaves it untouched).
   */
  async upsert(note: FSRSNote, id?: string): Promise<string> {
    const existing = await this.db
      .prepare("SELECT id FROM fsrs_notes WHERE email = ? AND url = ?")
      .bind(this.email, note.url)
      .first<{ id: string }>();
    const noteId = existing?.id ?? id ?? crypto.randomUUID();
    const cardDue = new Date(note.card.due).toISOString();
    await this.db
      .prepare(
        `INSERT INTO fsrs_notes
           (id, email, url, title, card, log, notes, speed_markers, hlc, device_id, card_due)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email, url) DO UPDATE SET
           title = excluded.title, card = excluded.card, log = excluded.log,
           notes = excluded.notes, speed_markers = excluded.speed_markers,
           hlc = excluded.hlc, device_id = excluded.device_id, card_due = excluded.card_due`,
      )
      .bind(
        noteId,
        this.email,
        note.url,
        note.title ?? null,
        JSON.stringify(note.card),
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

  async delete(url: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM fsrs_notes WHERE email = ? AND url = ?")
      .bind(this.email, url)
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
    const where: string[] = ["email = ?"];
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
        .prepare(`SELECT COUNT(*) AS c FROM fsrs_notes WHERE email = ? AND url IN (${holes})`)
        .bind(this.email, ...chunk)
        .first<{ c: number }>();
      await this.db
        .prepare(`DELETE FROM fsrs_notes WHERE email = ? AND url IN (${holes})`)
        .bind(this.email, ...chunk)
        .run();
      deleted += before?.c ?? 0;
    }
    return deleted;
  }

  /** Delete every note for this user. Unrecoverable. */
  async deleteAll(): Promise<number> {
    const before = await this.countAll();
    await this.db.prepare("DELETE FROM fsrs_notes WHERE email = ?").bind(this.email).run();
    return before;
  }

  async updateUrl(oldUrl: string, newUrl: string): Promise<void> {
    await this.db
      .prepare("UPDATE fsrs_notes SET url = ? WHERE email = ? AND url = ?")
      .bind(newUrl, this.email, oldUrl)
      .run();
  }
}
