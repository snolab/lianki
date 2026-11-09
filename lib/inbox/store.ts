/**
 * The inbox's D1 rows (db/migrations/0035_inbox.sql): one per file, and one
 * usage row per user, written in the same batch as each insert and delete.
 * `source` (0068_import_files.sql) tells the chat's attachments ('chat') from
 * the Import panel's stored files ('import'); usage and caps are shared.
 */

/** Where a stored file came from: the chat's attachments, or the Import panel. */
export type InboxSource = "chat" | "import";

/** The slice of D1 used here (the real binding, or lib/d1/testDb.ts). */
export type InboxStmt = {
  bind(...v: unknown[]): InboxStmt;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
};
export type InboxDb = {
  prepare(sql: string): InboxStmt;
  batch(s: InboxStmt[]): Promise<unknown>;
};

export type InboxItem = {
  id: string;
  ownerId: string;
  name: string;
  type: string;
  size: number;
  sha256: string;
  r2Key: string;
  createdMs: number;
  processedMs: number | null;
  lineId: string | null;
  source: InboxSource;
};

export type InboxUsage = {
  bytesStored: number;
  bytesUploaded: number;
  items: number;
  /** Storage cost is settled up to here (0: never stored anything). */
  settledMs: number;
};

type Row = {
  id: string;
  owner_id: string;
  name: string;
  type: string;
  size: number;
  sha256: string;
  r2_key: string;
  created_ms: number;
  processed_ms: number | null;
  line_id: string | null;
  source: string | null;
};
const COLS =
  "id, owner_id, name, type, size, sha256, r2_key, created_ms, processed_ms, line_id, source";
const item = (r: Row): InboxItem => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  type: r.type,
  size: Number(r.size),
  sha256: r.sha256,
  r2Key: r.r2_key,
  createdMs: Number(r.created_ms),
  processedMs: r.processed_ms === null ? null : Number(r.processed_ms),
  lineId: r.line_id,
  source: r.source === "import" ? "import" : "chat",
});

/** A user's stored files from one source, newest first (at most `limit`). */
export async function listItems(
  db: InboxDb,
  ownerId: string,
  limit = 200,
  source: InboxSource = "chat",
): Promise<InboxItem[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM inbox_item WHERE owner_id = ? AND source = ? ORDER BY created_ms DESC LIMIT ?`,
    )
    .bind(ownerId, source, limit)
    .all<Row>();
  return results.map(item);
}

/** Every owner's chat files (the agent's view: the inbox is the owners'), newest first. */
export async function listItemsOf(db: InboxDb, ownerIds: string[], limit = 200) {
  if (!ownerIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM inbox_item WHERE source = 'chat' AND owner_id IN (${ownerIds.map(() => "?").join(",")}) ORDER BY created_ms DESC LIMIT ?`,
    )
    .bind(...ownerIds, limit)
    .all<Row>();
  return results.map(item);
}

export async function getItem(db: InboxDb, id: string): Promise<InboxItem | null> {
  const r = await db.prepare(`SELECT ${COLS} FROM inbox_item WHERE id = ?`).bind(id).first<Row>();
  return r ? item(r) : null;
}

export async function usageOf(db: InboxDb, userId: string): Promise<InboxUsage> {
  const r = await db
    .prepare(
      "SELECT bytes_stored, bytes_uploaded, items, settled_ms FROM inbox_usage WHERE user_id = ?",
    )
    .bind(userId)
    .first<{ bytes_stored: number; bytes_uploaded: number; items: number; settled_ms: number }>();
  return {
    bytesStored: Number(r?.bytes_stored ?? 0),
    bytesUploaded: Number(r?.bytes_uploaded ?? 0),
    items: Number(r?.items ?? 0),
    settledMs: Number(r?.settled_ms ?? 0),
  };
}

/** Bytes a user uploaded since `since` (the rolling-day cap; deleted files no longer count). */
export async function uploadedSince(db: InboxDb, ownerId: string, since: number): Promise<number> {
  const r = await db
    .prepare(
      "SELECT COALESCE(SUM(size), 0) AS n FROM inbox_item WHERE owner_id = ? AND created_ms > ?",
    )
    .bind(ownerId, since)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** A stored file's row and its usage, in one batch (one transaction). */
export async function insertItem(
  db: InboxDb,
  it: Omit<InboxItem, "processedMs" | "lineId" | "source"> & { source?: InboxSource },
) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO inbox_item (id, owner_id, name, type, size, sha256, r2_key, created_ms, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        it.id,
        it.ownerId,
        it.name,
        it.type,
        it.size,
        it.sha256,
        it.r2Key,
        it.createdMs,
        it.source ?? "chat",
      ),
    db
      .prepare(
        `INSERT INTO inbox_usage (user_id, bytes_stored, bytes_uploaded, items, settled_ms, updated_ms) VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET bytes_stored = bytes_stored + excluded.bytes_stored,
           bytes_uploaded = bytes_uploaded + excluded.bytes_uploaded, items = items + 1,
           settled_ms = excluded.settled_ms, updated_ms = excluded.updated_ms`,
      )
      .bind(it.ownerId, it.size, it.size, it.createdMs, it.createdMs),
  ]);
}

/** Delete a row and lower its owner's usage, in one batch. */
export async function deleteItem(db: InboxDb, it: InboxItem, now: number) {
  await db.batch([
    db.prepare("DELETE FROM inbox_item WHERE id = ?").bind(it.id),
    db
      .prepare(
        "UPDATE inbox_usage SET bytes_stored = MAX(0, bytes_stored - ?), items = MAX(0, items - 1), settled_ms = ?, updated_ms = ? WHERE user_id = ?",
      )
      .bind(it.size, now, now, it.ownerId),
  ]);
}

/**
 * Move a user's storage settlement to `now` (the inbox view's open); the
 * caller charges the span it returns. Upload and delete move it in their own batch.
 */
export async function settleTo(db: InboxDb, userId: string, now: number) {
  await db
    .prepare(
      "UPDATE inbox_usage SET settled_ms = ?, updated_ms = ? WHERE user_id = ? AND settled_ms < ?",
    )
    .bind(now, now, userId, now)
    .run();
}

/** The line a set of the user's files was sent with. */
export async function linkLine(db: InboxDb, ownerId: string, ids: string[], lineId: string) {
  if (!ids.length) return;
  await db
    .prepare(
      `UPDATE inbox_item SET line_id = ? WHERE owner_id = ? AND line_id IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(lineId, ownerId, ...ids)
    .run();
}

export async function markProcessed(db: InboxDb, id: string, now: number) {
  const r = await db
    .prepare("UPDATE inbox_item SET processed_ms = ? WHERE id = ? RETURNING id")
    .bind(now, id)
    .first<{ id: string }>();
  return !!r;
}

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (s: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** A single-use download ticket for one file; only its hash is stored. */
export async function mintTicket(db: InboxDb, id: string, now: number, ttlMs: number) {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const ticket = hex(raw.buffer);
  const r = await db
    .prepare("UPDATE inbox_item SET ticket_hash = ?, ticket_exp = ? WHERE id = ? RETURNING id")
    .bind(await sha256Hex(ticket), now + ttlMs, id)
    .first<{ id: string }>();
  return r ? { ticket, exp: now + ttlMs } : null;
}

/** Spend a ticket: true once, for its own file, before it expires. */
export async function spendTicket(db: InboxDb, id: string, ticket: string, now: number) {
  if (!/^[0-9a-f]{64}$/.test(ticket)) return false;
  const r = await db
    .prepare(
      "UPDATE inbox_item SET ticket_hash = NULL, ticket_exp = NULL WHERE id = ? AND ticket_hash = ? AND ticket_exp > ? RETURNING id",
    )
    .bind(id, await sha256Hex(ticket), now)
    .first<{ id: string }>();
  return !!r;
}
