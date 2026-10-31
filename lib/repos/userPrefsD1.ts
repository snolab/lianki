import type { D1Like } from "@/lib/d1/types";
import {
  checkPref,
  isPrefKey,
  MAX_CLOCK_AHEAD_MS,
  MAX_ROWS,
  type PrefHlc,
  type PrefOp,
  type PrefRow,
} from "@/lib/prefs/schema";

type Row = {
  key: string;
  value: string;
  hlc_ts: number;
  hlc_counter: number;
  device_id: string;
  updated_ms: number;
};

const toRow = (r: Row): PrefRow => ({
  value: JSON.parse(r.value),
  hlc: { timestamp: r.hlc_ts, counter: r.hlc_counter, deviceId: r.device_id },
});

export type PrefsRead = { prefs: Record<string, PrefRow>; cursor: number };
export type PrefsWrite = { prefs: Record<string, PrefRow>; rejected: string[] };

/**
 * A read with `since` also returns rows this much older: a write that took
 * its timestamp before a read but committed after it is not missed.
 */
export const SINCE_OVERLAP_MS = 5000;

/**
 * user_prefs (docs/prefs-sync.md): per-field last-write-wins by HLC. A write
 * lands only when its HLC is strictly newer than the stored one, decided in
 * the upsert's WHERE, so two writes racing on D1 cannot both win.
 */
export class UserPrefsD1Repo {
  constructor(
    private readonly db: D1Like,
    private readonly userId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every row (since = 0) or those written at or after `since` (server ms). Unknown keys are left out. */
  async read(since = 0): Promise<PrefsRead> {
    const { results } = await this.db
      .prepare(
        `SELECT key, value, hlc_ts, hlc_counter, device_id, updated_ms FROM user_prefs
         WHERE user_id = ? AND updated_ms >= ?`,
      )
      .bind(this.userId, since > 0 ? since - SINCE_OVERLAP_MS : 0)
      .all<Row>();
    const prefs: Record<string, PrefRow> = {};
    let cursor = since;
    for (const r of results) {
      cursor = Math.max(cursor, r.updated_ms);
      if (!isPrefKey(r.key)) continue;
      try {
        prefs[r.key] = toRow(r);
      } catch {}
    }
    return { prefs, cursor };
  }

  /**
   * Apply each op that passes its schema and is newer than what is stored.
   * The cursor is not advanced: rows other devices wrote meanwhile are
   * still to be read. Returns the winning row of every key it was sent (so a client whose write
   * lost adopts the winner) and the keys it refused.
   */
  async write(ops: PrefOp[]): Promise<PrefsWrite> {
    const now = this.now();
    const rejected: string[] = [];
    const sent = new Set<string>();
    let count: number | null = null;
    for (const op of ops) {
      const value = checkPref(op.key, op.value);
      if (value === undefined) {
        rejected.push(op.key);
        continue;
      }
      if (count === null) count = await this.count();
      // A clock far ahead of the server's is clamped to the server's now
      // (sync-merge-rules.md, edge case 8): it cannot win for hours.
      const hlc: PrefHlc =
        op.hlc.timestamp > now + MAX_CLOCK_AHEAD_MS ? { ...op.hlc, timestamp: now } : op.hlc;
      const exists = await this.db
        .prepare("SELECT 1 AS x FROM user_prefs WHERE user_id = ? AND key = ?")
        .bind(this.userId, op.key)
        .first();
      if (!exists && count >= MAX_ROWS) {
        rejected.push(op.key);
        continue;
      }
      await this.db
        .prepare(
          `INSERT INTO user_prefs (user_id, key, value, hlc_ts, hlc_counter, device_id, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, key) DO UPDATE SET
             value = excluded.value, hlc_ts = excluded.hlc_ts, hlc_counter = excluded.hlc_counter,
             device_id = excluded.device_id, updated_ms = excluded.updated_ms
           WHERE (excluded.hlc_ts, excluded.hlc_counter, excluded.device_id)
               > (user_prefs.hlc_ts, user_prefs.hlc_counter, user_prefs.device_id)`,
        )
        .bind(
          this.userId,
          op.key,
          JSON.stringify(value),
          hlc.timestamp,
          hlc.counter,
          hlc.deviceId,
          now,
        )
        .run();
      if (!exists) count++;
      sent.add(op.key);
    }
    const prefs: Record<string, PrefRow> = {};
    if (sent.size) {
      const all = await this.read(0);
      for (const k of sent) if (all.prefs[k]) prefs[k] = all.prefs[k];
    }
    return { prefs, rejected };
  }

  async count(): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = ?")
      .bind(this.userId)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  /** key → value, for the data export (no clocks). */
  async exportValues(): Promise<Record<string, unknown>> {
    const { prefs } = await this.read(0);
    return Object.fromEntries(Object.entries(prefs).map(([k, r]) => [k, r.value]));
  }
}
