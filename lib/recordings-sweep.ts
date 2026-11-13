/**
 * Retention of mic recordings (docs/recordings.md, "Retention"): once a day
 * the Worker's existing Cron Trigger (worker.ts `scheduled`, beside the
 * ledger's anchor and /vibe's sweep) deletes every clip recorded more than
 * config `recordings.retentionDays` days ago, its R2 object first, then its
 * row. Nothing new polls. Kept free of the request-side imports (crypto,
 * tickets) so the Worker entry stays small.
 */
import { parseStoredConfig, defaultConfig } from "@/lib/config";

const DAY_MS = 86_400_000;
/** Rows per pass and passes per run: a bound on one daily run (the next run takes the rest). */
export const SWEEP_PAGE = 200;
export const SWEEP_PASSES = 25;

/** The R2 object of one clip. */
export const objectKey = (uid: string, day: string, id: string) => `recordings/${uid}/${day}/${id}`;

/** What the sweep needs of D1. */
export type SweepDb = {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
  };
};

/** The retention in force: the stored value when valid, else the code default. */
export async function retentionDays(db: SweepDb): Promise<number> {
  const key = "recordings.retentionDays";
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
 * Delete every clip recorded more than `days` days before `now` (any
 * account): object first, then row, so a row never points at nothing.
 */
export async function sweepRecordings(
  db: SweepDb,
  blobs: { delete(key: string): Promise<unknown> } | null | undefined,
  days: number,
  now: number,
): Promise<number> {
  if (!Number.isFinite(days) || days < 1) return 0;
  const cutoff = now - days * DAY_MS;
  let n = 0;
  for (let pass = 0; pass < SWEEP_PASSES; pass++) {
    const { results } = await db
      .prepare("SELECT user_id AS uid, id, day FROM recording WHERE at < ? LIMIT ?")
      .bind(cutoff, SWEEP_PAGE)
      .all<{ uid: string; id: string; day: string }>();
    const rows = results ?? [];
    for (const r of rows) {
      if (blobs) await blobs.delete(objectKey(r.uid, r.day, r.id));
      await db
        .prepare("DELETE FROM recording WHERE user_id = ? AND id = ?")
        .bind(r.uid, r.id)
        .run();
      n++;
    }
    if (rows.length < SWEEP_PAGE) break;
  }
  return n;
}
