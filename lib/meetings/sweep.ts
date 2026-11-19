/**
 * Meetings' daily jobs and the delete itself (docs/meetings.md, "Delete",
 * "Pause, stop, tab close"). Run by the Worker's existing Cron Trigger
 * (worker.ts `scheduled`, beside lib/recordings-sweep.ts); nothing polls.
 *
 * 1. finish deletes cut short (rows left `deleting`),
 * 2. a meeting left `recording` with no piece for `meetings.staleMin` → `interrupted`,
 * 3. with `meetings.retentionDays` > 0, meetings that started before it are deleted.
 *
 * Kept free of the request-side imports (crypto, keys) so the Worker entry stays small.
 */
import { defaultConfig, parseStoredConfig } from "@/lib/config";
import { meetingPrefix } from "./core";

const DAY_MS = 86_400_000;
/** Meetings handled per job and run: a bound on one daily run (the next run takes the rest). */
export const SWEEP_MEETINGS = 50;
/** R2 `delete()` takes up to 1,000 keys a call. */
export const R2_DELETE_MAX = 1_000;

export type SweepStmt = {
  bind(...v: unknown[]): SweepStmt;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } } | unknown>;
};
export type SweepDb = {
  prepare(sql: string): SweepStmt;
  batch(stmts: SweepStmt[]): Promise<unknown>;
};
/** The part of an R2 bucket a purge uses. */
export type PurgeBlobs = {
  list(o: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<unknown>;
};

async function storedInt(db: SweepDb, key: "meetings.retentionDays" | "meetings.staleMin") {
  try {
    const r = await db
      .prepare("SELECT value_json FROM config_values WHERE key = ?")
      .bind(key)
      .first<{ value_json: string }>();
    const v = parseStoredConfig(key, r?.value_json);
    if (v !== undefined) return v;
  } catch {}
  return defaultConfig()[key];
}

/**
 * Delete one meeting for good: every object under its prefix (listed, in
 * calls of ≤ 1,000 keys), then its lines, pieces and row. The row is the last
 * to go, so a purge cut short is found again by its `deleting` status.
 */
export async function purgeMeeting(
  db: SweepDb,
  blobs: PurgeBlobs | null | undefined,
  uid: string,
  id: string,
): Promise<number> {
  let n = 0;
  if (blobs) {
    const prefix = meetingPrefix(uid, id);
    let cursor: string | undefined;
    for (;;) {
      const page = await blobs.list({ prefix, cursor, limit: R2_DELETE_MAX });
      const keys = page.objects.map((o) => o.key).filter((k) => k.startsWith(prefix));
      for (let i = 0; i < keys.length; i += R2_DELETE_MAX) {
        await blobs.delete(keys.slice(i, i + R2_DELETE_MAX));
        n += Math.min(R2_DELETE_MAX, keys.length - i);
      }
      if (!page.truncated || !page.cursor) break;
      cursor = page.cursor;
    }
  }
  await db.batch([
    db.prepare("DELETE FROM meeting_line WHERE user_id = ? AND meeting_id = ?").bind(uid, id),
    db.prepare("DELETE FROM meeting_chunk WHERE user_id = ? AND meeting_id = ?").bind(uid, id),
    db.prepare("DELETE FROM meeting WHERE user_id = ? AND id = ?").bind(uid, id),
  ]);
  return n;
}

export type SweepResult = { purged: number; interrupted: number; expired: number };

export async function sweepMeetings(
  db: SweepDb,
  blobs: PurgeBlobs | null | undefined,
  now: number,
): Promise<SweepResult> {
  const out: SweepResult = { purged: 0, interrupted: 0, expired: 0 };
  // 3 first: expired meetings become `deleting`, then 1 finishes them with the rest.
  const days = await storedInt(db, "meetings.retentionDays");
  if (days > 0) {
    const r = await db
      .prepare(
        "UPDATE meeting SET status = 'deleting' WHERE rowid IN (SELECT rowid FROM meeting WHERE status != 'deleting' AND started_at < ? LIMIT ?)",
      )
      .bind(now - days * DAY_MS, SWEEP_MEETINGS)
      .run();
    out.expired = Number((r as { meta?: { changes?: number } })?.meta?.changes ?? 0);
  }
  const { results } = await db
    .prepare("SELECT user_id AS uid, id FROM meeting WHERE status = 'deleting' LIMIT ?")
    .bind(SWEEP_MEETINGS)
    .all<{ uid: string; id: string }>();
  for (const m of results ?? []) {
    await purgeMeeting(db, blobs, m.uid, m.id);
    out.purged++;
  }
  const stale = await storedInt(db, "meetings.staleMin");
  const cutoff = now - stale * 60_000;
  const r = await db
    .prepare(
      "UPDATE meeting SET status = 'interrupted', ended_at = COALESCE(last_chunk_at, started_at) WHERE status = 'recording' AND COALESCE(last_chunk_at, started_at) < ?",
    )
    .bind(cutoff)
    .run();
  out.interrupted = Number((r as { meta?: { changes?: number } })?.meta?.changes ?? 0);
  return out;
}
