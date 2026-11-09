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

interface FlagCacheState {
  cache: { at: number; values: FlagSnapshot } | null;
  /** The shared read, and when it started (its snapshot is at least that old). */
  inflight: { at: number; p: Promise<FlagSnapshot> } | null;
  /** Bumped by every clear, so a read that started before it never fills the cache. */
  generation: number;
}

/**
 * One cache per isolate, on globalThis. The build gives route handlers and
 * page rendering each their own copy of this module, so module-level state was
 * two caches up to 30 s apart: an API route saw a flag on while its page still
 * 404'd (qa-yt-songs timed out on exactly that, 2026-11-09), and a write on
 * /dev/flags cleared only the route side.
 */
const state: FlagCacheState = ((globalThis as { __lkFlagCache?: FlagCacheState }).__lkFlagCache ??=
  { cache: null, inflight: null, generation: 0 });

/** Forget the cached snapshot (after a write here; and between unit tests). */
export function clearFlagCache(): void {
  state.cache = null;
  state.inflight = null;
  state.generation++;
}

async function fetchFlags(db: () => D1Like | null, at: number, gen: number): Promise<FlagSnapshot> {
  const d1 = db();
  if (!d1) return closedFlags();
  const values = await loadFlags(d1);
  // Only a real read is cached, and only if no write cleared the cache meanwhile.
  if (gen === state.generation) state.cache = { at, values };
  return values;
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
  const t = now();
  const { cache } = state;
  if (cache && t - cache.at >= 0 && t - cache.at < FLAG_CACHE_MS) return { ...cache.values };
  // Concurrent misses share one query; it is forgotten once settled, so a
  // failure is retried by the next call rather than remembered. A read that
  // started a window ago or more is not joined: its answer may predate a flip
  // by more than FLAG_CACHE_MS, so a fresh read starts instead.
  const fresh = (at: number, end: number) => end - at >= 0 && end - at < FLAG_CACHE_MS;
  let mine = state.inflight;
  if (!mine || !fresh(mine.at, t)) {
    const started = { at: t, p: fetchFlags(db, t, state.generation) };
    mine = state.inflight = started;
    started.p.then(
      () => void (state.inflight === started && (state.inflight = null)),
      () => void (state.inflight === started && (state.inflight = null)),
    );
  }
  try {
    const values = await mine.p;
    // The same bound on the way out: a read held past the window is too old to
    // act on, whoever started it. Fail closed.
    if (!fresh(mine.at, now())) {
      console.error(JSON.stringify({ event: "flags.read-stale", ms: now() - mine.at }));
      return closedFlags();
    }
    return { ...values };
  } catch (e) {
    console.error(JSON.stringify({ event: "flags.read-failed", error: String(e) }));
    return closedFlags();
  }
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
