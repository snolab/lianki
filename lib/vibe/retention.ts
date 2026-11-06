// The transcript retention sweep (docs/vibe.md, "Retention"), run once a day by
// the Worker's existing Cron Trigger (worker.ts `scheduled`): nothing new polls.
// A transcript goes when its newest line is older than its owner's retention.
import { deleteReaderRows, type D1Batch } from "@/lib/read/reader-store";
import { RETENTION_DEFAULT_DAYS } from "./gate";

const DAY_MS = 86_400_000;
/** At most this many per pass; passes repeat until none are left (a bound on one run). */
const PAGE = 100;
const MAX_PASSES = 10;

type Row = {
  id: string;
  user_id: string;
  material_id: string | null;
  r2_key: string | null;
  content_hash: string | null;
};

export type VibeBlobs = { delete(key: string): Promise<unknown> };

export async function sweepVibeDocs(
  db: D1Batch,
  blobs: VibeBlobs | null | undefined,
  nowMs: number,
): Promise<number> {
  let swept = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { results } = await db
      .prepare(
        `SELECT d.id, d.user_id, d.material_id, m.r2_key, m.content_hash
         FROM vibe_doc d
         LEFT JOIN vibe_settings s ON s.user_id = d.user_id
         LEFT JOIN read_materials m ON m.id = d.material_id AND m.user_id = d.user_id
         WHERE d.last_ms + COALESCE(s.retention_days, ?) * ${DAY_MS} <= ?
         LIMIT ${PAGE}`,
      )
      .bind(RETENTION_DEFAULT_DAYS, nowMs)
      .all<Row>();
    const rows = results ?? [];
    for (const r of rows) {
      if (r.material_id) {
        await deleteReaderRows(db, r.user_id, r.material_id, r.content_hash);
        if (r.r2_key) await blobs?.delete(r.r2_key);
        await db
          .prepare("DELETE FROM read_materials WHERE id = ? AND user_id = ?")
          .bind(r.material_id, r.user_id)
          .run();
      }
      await db.prepare("DELETE FROM vibe_doc WHERE id = ?").bind(r.id).run();
      swept++;
    }
    if (rows.length < PAGE) break;
  }
  return swept;
}
