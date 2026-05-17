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

  async updateUrl(oldUrl: string, newUrl: string): Promise<void> {
    await this.db
      .prepare("UPDATE fsrs_notes SET url = ? WHERE email = ? AND url = ?")
      .bind(newUrl, this.email, oldUrl)
      .run();
  }
}
