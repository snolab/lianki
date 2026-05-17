import type { FSRSNote } from "@/app/fsrs";
import type { D1Like } from "@/lib/d1/types";
import { restoreNoteFromExport } from "@/lib/yaml-export";

type Row = {
  user_id: string;
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

function rowToNote(row: Row): FSRSNote {
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
  return restoreNoteFromExport(raw) as unknown as FSRSNote;
}

/** D1-backed access to one user's FSRS notes (replaces MongoDB `FSRSNotes@{email}`). */
export class FsrsNotesD1Repo {
  constructor(
    private readonly db: D1Like,
    private readonly userId: string,
  ) {}

  async getByUrl(url: string): Promise<FSRSNote | null> {
    const row = await this.db
      .prepare("SELECT * FROM fsrs_notes WHERE user_id = ? AND url = ?")
      .bind(this.userId, url)
      .first<Row>();
    return row ? rowToNote(row) : null;
  }

  async listAll(): Promise<FSRSNote[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM fsrs_notes WHERE user_id = ? ORDER BY card_due")
      .bind(this.userId)
      .all<Row>();
    return results.map(rowToNote);
  }

  async listDue(now: Date, limit: number): Promise<FSRSNote[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM fsrs_notes WHERE user_id = ? AND card_due <= ? ORDER BY card_due LIMIT ?",
      )
      .bind(this.userId, now.toISOString(), limit)
      .all<Row>();
    return results.map(rowToNote);
  }

  async countAll(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS c FROM fsrs_notes WHERE user_id = ?")
      .bind(this.userId)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  async countDue(now: Date): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS c FROM fsrs_notes WHERE user_id = ? AND card_due <= ?")
      .bind(this.userId, now.toISOString())
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  /** Insert or replace the note keyed by (user_id, url). */
  async upsert(note: FSRSNote): Promise<void> {
    const cardDue = new Date(note.card.due).toISOString();
    await this.db
      .prepare(
        `INSERT INTO fsrs_notes
           (user_id, url, title, card, log, notes, speed_markers, hlc, device_id, card_due)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, url) DO UPDATE SET
           title = excluded.title, card = excluded.card, log = excluded.log,
           notes = excluded.notes, speed_markers = excluded.speed_markers,
           hlc = excluded.hlc, device_id = excluded.device_id, card_due = excluded.card_due`,
      )
      .bind(
        this.userId,
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
  }

  async delete(url: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM fsrs_notes WHERE user_id = ? AND url = ?")
      .bind(this.userId, url)
      .run();
  }

  async updateUrl(oldUrl: string, newUrl: string): Promise<void> {
    await this.db
      .prepare("UPDATE fsrs_notes SET url = ? WHERE user_id = ? AND url = ?")
      .bind(newUrl, this.userId, oldUrl)
      .run();
  }
}
