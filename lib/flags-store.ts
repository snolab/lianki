/**
 * Feature flags over D1 (`feature_flags`, `feature_flag_log`; migration 0027).
 * The registry is lib/flags.ts; the owner's page is /dev/flags.
 * docs/feature-flags.md.
 *
 * - **Read** with `readFlags()`: one small query, cached in this isolate for
 *   `FLAG_CACHE_MS` (30 s), so a request does not hit D1 for every check and a
 *   change made on /dev/flags reaches every isolate within 30 s, no deploy.
 *   Concurrent misses share one query. No snapshot older than the window is
 *   ever returned — cached, joined or held (a held read past it is off).
 * - **Defaults**: a key with no row reads as its registry default
 *   (lib/flags.ts; off, but for a few that keep a live thing switchable).
 * - **Fail closed**: off the D1 backend, or when the read throws, every flag is
 *   OFF for that call, a default-on one too. A failure is not cached, so the next call tries again.
 * - **Write** with `setFlag()`: registry keys only; the row and its log entry
 *   in one batch (one transaction). The writing isolate drops its cache at
 *   once; the others follow within the window.
 */
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import { snapshotCache } from "@/lib/snapshot-cache";
import {
  closedFlags,
  defaultFlags,
  FLAG_KEYS,
  FLAGS,
  isFlagKey,
  storedFlagRow,
  type FlagKey,
} from "./flags";

export type D1WithBatch = D1Like & { batch(stmts: D1StmtLike[]): Promise<unknown> };

/** The longest a flag change takes to reach a request (per isolate cache). */
export const FLAG_CACHE_MS = 30_000;

export type FlagSnapshot = Record<FlagKey, boolean>;

/**
 * One cache per isolate, on globalThis (lib/snapshot-cache.ts): route handlers
 * and page rendering get their own copy of this module, and module-level state
 * was two caches up to 30 s apart (qa-yt-songs, 2026-11-09). Fails closed.
 */
const flagCache = snapshotCache<FlagSnapshot>({
  slot: "__lkFlagCache",
  ttlMs: FLAG_CACHE_MS,
  fallback: closedFlags,
  copy: (v) => ({ ...v }),
  event: "flags",
});

/** Forget the cached snapshot (after a write here; and between unit tests). */
export function clearFlagCache(): void {
  flagCache.clear();
}

/** Read every flag straight from D1 (no cache). Throws on a D1 error. */
export async function loadFlags(d1: D1Like): Promise<FlagSnapshot> {
  const { results } = await d1
    .prepare("SELECT key, enabled FROM feature_flags")
    .all<{ key: string; enabled: number }>();
  const values = defaultFlags();
  const rows = new Map(results.map((r) => [r.key, r]));
  // Unknown keys are ignored (a renamed flag's old key is read through its new
  // one); only exactly 1 is on.
  for (const key of FLAG_KEYS) {
    const r = storedFlagRow(rows, key);
    if (r) values[key] = r.enabled === 1;
  }
  return values;
}

function defaultDb(): D1Like | null {
  return dbBackend() === "d1" ? (getD1() as unknown as D1Like) : null;
}

/**
 * Every flag, at most `FLAG_CACHE_MS` old; all OFF when D1 cannot be read.
 * `db` and `now` are for tests.
 */
export async function readFlags(
  db: () => D1Like | null = defaultDb,
  now: () => number = Date.now,
): Promise<FlagSnapshot> {
  return flagCache.read(async () => {
    const d1 = db();
    return d1 ? loadFlags(d1) : null;
  }, now);
}

/** Whether one flag is on now (fail closed, cached like `readFlags`). */
export async function flagOn(key: FlagKey): Promise<boolean> {
  return (await readFlags())[key] === true;
}

export interface FlagRow {
  key: FlagKey;
  description: string;
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface FlagLogEntry {
  key: string;
  enabled: boolean;
  at: string;
  by: string;
}

/** Every registry flag with its stored state (for /dev/flags; no cache). */
export async function listFlags(d1: D1Like): Promise<FlagRow[]> {
  const { results } = await d1
    .prepare("SELECT key, enabled, updated_at, updated_by FROM feature_flags")
    .all<{ key: string; enabled: number; updated_at: string; updated_by: string }>();
  const byKey = new Map(results.map((r) => [r.key, r]));
  return (Object.keys(FLAGS) as FlagKey[]).map((key) => {
    const r = storedFlagRow(byKey, key);
    return {
      key,
      description: FLAGS[key].description,
      // No row: the registry default (a stored row always wins).
      enabled: r ? r.enabled === 1 : (FLAGS[key].default as boolean),
      updatedAt: r?.updated_at ?? null,
      updatedBy: r?.updated_by ?? null,
    };
  });
}

/** The newest changes first. */
export async function flagLog(d1: D1Like, limit = 50): Promise<FlagLogEntry[]> {
  const { results } = await d1
    .prepare("SELECT key, enabled, at, by FROM feature_flag_log ORDER BY id DESC LIMIT ?")
    .bind(Math.max(1, Math.min(500, Math.floor(limit))))
    .all<{ key: string; enabled: number; at: string; by: string }>();
  return results.map((r) => ({ key: r.key, enabled: r.enabled === 1, at: r.at, by: r.by }));
}

export class FlagError extends Error {}

/**
 * Turn a registry flag on or off, recording who and when. Refuses an unknown
 * key or a non-boolean value (FlagError) before touching D1.
 */
export async function setFlag(
  d1: D1WithBatch,
  key: unknown,
  enabled: unknown,
  by: string,
  now = new Date(),
): Promise<FlagRow> {
  if (!isFlagKey(key)) throw new FlagError("Unknown flag");
  if (typeof enabled !== "boolean") throw new FlagError("enabled must be true or false");
  if (!by.trim()) throw new FlagError("Who is changing it?");
  const at = now.toISOString();
  const v = enabled ? 1 : 0;
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(key, v, at, by),
    d1
      .prepare("INSERT INTO feature_flag_log (key, enabled, at, by) VALUES (?, ?, ?, ?)")
      .bind(key, v, at, by),
  ]);
  clearFlagCache();
  console.log(JSON.stringify({ event: "flags.set", key, enabled, by, at }));
  return {
    key,
    description: FLAGS[key].description,
    enabled,
    updatedAt: at,
    updatedBy: by,
  };
}
