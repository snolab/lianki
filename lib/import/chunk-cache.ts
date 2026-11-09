/**
 * "Words with AI": each paid chunk's rows, per user and stored file, keyed by
 * the chunk's hash (db/migrations/0069_ai_chunk_cache.sql). A conversion that
 * stopped for want of credits resumes after a top-up and pays only for the
 * chunks not done. Deleted with the file. Not a guarantee of a resume.
 */
import type { D1Like } from "@/lib/d1/types";
import type { AiRow } from "./ai-convert";

export type ChunkCache = {
  get(userId: string, fileId: string, hash: string): Promise<AiRow[] | null>;
  put(userId: string, fileId: string, hash: string, rows: AiRow[]): Promise<void>;
};

/** A stable hash of one call (its model and messages): the cache key of its chunk. */
export async function chunkHash(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The cache in D1; a read or write that fails is a miss, never an error. */
export function d1ChunkCache(db: D1Like, now: () => number = Date.now): ChunkCache {
  return {
    async get(userId, fileId, hash) {
      try {
        const r = await db
          .prepare(
            "SELECT rows_json FROM ai_chunk_cache WHERE user_id = ? AND file_id = ? AND chunk_hash = ?",
          )
          .bind(userId, fileId, hash)
          .first<{ rows_json: string }>();
        if (!r) return null;
        const rows = JSON.parse(r.rows_json) as unknown;
        return Array.isArray(rows) ? (rows as AiRow[]) : null;
      } catch {
        return null;
      }
    },
    async put(userId, fileId, hash, rows) {
      try {
        await db
          .prepare(
            "INSERT INTO ai_chunk_cache (user_id, file_id, chunk_hash, rows_json, created_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, file_id, chunk_hash) DO UPDATE SET rows_json = excluded.rows_json, created_ms = excluded.created_ms",
          )
          .bind(userId, fileId, hash, JSON.stringify(rows), now())
          .run();
      } catch {}
    },
  };
}

/** Drop a file's cached chunks (the file was deleted). */
export async function dropChunks(db: D1Like, userId: string, fileId: string): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM ai_chunk_cache WHERE user_id = ? AND file_id = ?")
      .bind(userId, fileId)
      .run();
  } catch {}
}
