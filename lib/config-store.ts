/**
 * The config store over D1 (`config_values`, `config_log`; migration 0070).
 * The registry is lib/config.ts; the owner's editor is /dev/config.
 * docs/config-store.md.
 *
 * - **Read** with `cfg(key)` (or `readConfig()` for all): one small query,
 *   cached per isolate for `CONFIG_CACHE_MS` (30 s, lib/snapshot-cache.ts), so
 *   a change on /dev/config reaches every request within 30 s, no deploy.
 * - **Fail to defaults**: off the D1 backend, when the read throws, or for a
 *   stored value that no longer passes its schema, the registry default is
 *   used. A failed read is not cached.
 * - **Write** with `setConfig()` / `resetConfig()`: registry keys only, the
 *   value checked against its schema; the row and its log entry in one batch
 *   (one transaction). The writing isolate drops its cache at once.
 */
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import type { D1WithBatch } from "@/lib/flags-store";
import { snapshotCache } from "@/lib/snapshot-cache";
import {
  CONFIG,
  CONFIG_KEYS,
  defaultConfig,
  isConfigKey,
  parseConfigValue,
  parseStoredConfig,
  publicSubset,
  resolveConfig,
  type ConfigDef,
  type ConfigKey,
  type ConfigValue,
  type ConfigValues,
  type PublicConfigValues,
} from "./config";

/** The longest a config change takes to reach a request (per isolate cache). */
export const CONFIG_CACHE_MS = 30_000;

const configCache = snapshotCache<ConfigValues>({
  slot: "__lkConfigCache",
  ttlMs: CONFIG_CACHE_MS,
  fallback: defaultConfig,
  copy: (v) => ({ ...v }),
  event: "config",
});

/** Forget the cached snapshot (after a write here; and between unit tests). */
export function clearConfigCache(): void {
  configCache.clear();
}

/** Every value straight from D1 (no cache); an invalid row reads as the default. Throws on a D1 error. */
export async function loadConfig(d1: D1Like): Promise<ConfigValues> {
  const { results } = await d1
    .prepare("SELECT key, value_json FROM config_values")
    .all<{ key: string; value_json: string }>();
  const values = defaultConfig() as Record<ConfigKey, unknown>;
  for (const r of results) {
    if (!isConfigKey(r.key)) continue;
    const v = parseStoredConfig(r.key, r.value_json);
    if (v === undefined) console.error(JSON.stringify({ event: "config.invalid", key: r.key }));
    else values[r.key] = v;
  }
  return values as ConfigValues;
}

function defaultDb(): D1Like | null {
  return dbBackend() === "d1" ? (getD1() as unknown as D1Like) : null;
}

/** Every value, at most `CONFIG_CACHE_MS` old; the defaults when D1 cannot be read. */
export async function readConfig(
  db: () => D1Like | null = defaultDb,
  now: () => number = Date.now,
): Promise<ConfigValues> {
  return configCache.read(async () => {
    const d1 = db();
    return d1 ? loadConfig(d1) : null;
  }, now);
}

/**
 * One value in effect: code default → global value → `user`'s own (only for a
 * key with `userPref`, and only if it validates).
 */
export async function cfg<K extends ConfigKey>(key: K, user?: unknown): Promise<ConfigValue<K>> {
  return resolveConfig(key, (await readConfig())[key], user);
}

/** The values the browser may see (public keys only). */
export async function publicConfig(): Promise<PublicConfigValues> {
  return publicSubset(await readConfig());
}

export interface ConfigRow {
  key: ConfigKey;
  /** The value in effect (the default when nothing valid is stored). */
  value: unknown;
  default: unknown;
  /** A row is stored and valid. */
  stored: boolean;
  /** A row is stored but fails the schema now (it reads as the default). */
  invalid: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ConfigLogEntry {
  key: string;
  old: unknown;
  new: unknown;
  by: string;
  at: string;
  note: string | null;
}

/** Every registry key with its stored state (for /dev/config; no cache). */
export async function listConfig(d1: D1Like): Promise<ConfigRow[]> {
  const { results } = await d1
    .prepare("SELECT key, value_json, updated_at, updated_by FROM config_values")
    .all<{ key: string; value_json: string; updated_at: string; updated_by: string }>();
  const byKey = new Map(results.map((r) => [r.key, r]));
  return CONFIG_KEYS.map((key) => {
    const r = byKey.get(key);
    const v = r ? parseStoredConfig(key, r.value_json) : undefined;
    return {
      key,
      value: v ?? CONFIG[key].default,
      default: CONFIG[key].default,
      stored: v !== undefined,
      invalid: r !== undefined && v === undefined,
      updatedAt: r?.updated_at ?? null,
      updatedBy: r?.updated_by ?? null,
    };
  });
}

const fromJson = (s: string | null): unknown => {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** The newest changes first, of one key or all. */
export async function configLog(d1: D1Like, limit = 50, key?: string): Promise<ConfigLogEntry[]> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  const stmt = key
    ? d1
        .prepare(
          "SELECT key, old_json, new_json, by, at, note FROM config_log WHERE key = ? ORDER BY id DESC LIMIT ?",
        )
        .bind(key, n)
    : d1
        .prepare(
          "SELECT key, old_json, new_json, by, at, note FROM config_log ORDER BY id DESC LIMIT ?",
        )
        .bind(n);
  const { results } = await stmt.all<{
    key: string;
    old_json: string | null;
    new_json: string | null;
    by: string;
    at: string;
    note: string | null;
  }>();
  return results.map((r) => ({
    key: r.key,
    old: fromJson(r.old_json),
    new: fromJson(r.new_json),
    by: r.by,
    at: r.at,
    note: r.note,
  }));
}

export class ConfigError extends Error {}

export interface WriteOpts {
  note?: string | null;
  /** Required for a `money` key. */
  confirmMoney?: boolean;
  now?: Date;
}

const NOTE_MAX = 500;

function checkWrite(key: unknown, by: string, opts: WriteOpts): asserts key is ConfigKey {
  if (!isConfigKey(key)) throw new ConfigError("Unknown key");
  if (!by.trim()) throw new ConfigError("Who is changing it?");
  if ((CONFIG[key] as ConfigDef).money && opts.confirmMoney !== true)
    throw new ConfigError("A money value needs confirmMoney");
  if (opts.note != null && (typeof opts.note !== "string" || opts.note.length > NOTE_MAX))
    throw new ConfigError(`note: text up to ${NOTE_MAX} characters`);
}

/** The log row, reading the old value in the same transaction as the write that follows it. */
const logStmt = (
  d1: D1WithBatch,
  key: string,
  newJson: string | null,
  by: string,
  at: string,
  note: string | null,
) =>
  d1
    .prepare(
      `INSERT INTO config_log (key, old_json, new_json, by, at, note)
       VALUES (?, (SELECT value_json FROM config_values WHERE key = ?), ?, ?, ?, ?)`,
    )
    .bind(key, key, newJson, by, at, note);

/**
 * Set a registry key's global value, recording who, when and why. Refuses an
 * unknown key or an invalid value (ConfigError) before touching D1.
 */
export async function setConfig(
  d1: D1WithBatch,
  key: unknown,
  value: unknown,
  by: string,
  opts: WriteOpts = {},
): Promise<ConfigRow> {
  checkWrite(key, by, opts);
  const parsed = parseConfigValue(key, value);
  if (!parsed.ok) throw new ConfigError(`${key}: ${parsed.error}`);
  const at = (opts.now ?? new Date()).toISOString();
  const json = JSON.stringify(parsed.value);
  await d1.batch([
    logStmt(d1, key, json, by, at, opts.note ?? null),
    d1
      .prepare(
        `INSERT INTO config_values (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(key, json, at, by),
  ]);
  clearConfigCache();
  console.log(JSON.stringify({ event: "config.set", key, by, at }));
  return {
    key,
    value: parsed.value,
    default: CONFIG[key].default,
    stored: true,
    invalid: false,
    updatedAt: at,
    updatedBy: by,
  };
}

/** Back to the registry default: the row is removed, the change logged (new = null). */
export async function resetConfig(
  d1: D1WithBatch,
  key: unknown,
  by: string,
  opts: WriteOpts = {},
): Promise<ConfigRow> {
  checkWrite(key, by, opts);
  const at = (opts.now ?? new Date()).toISOString();
  await d1.batch([
    logStmt(d1, key, null, by, at, opts.note ?? null),
    d1.prepare("DELETE FROM config_values WHERE key = ?").bind(key),
  ]);
  clearConfigCache();
  console.log(JSON.stringify({ event: "config.reset", key, by, at }));
  return {
    key,
    value: CONFIG[key].default,
    default: CONFIG[key].default,
    stored: false,
    invalid: false,
    updatedAt: null,
    updatedBy: null,
  };
}

/**
 * The editor's POST body → a set or a reset: `{ key, value, note?, confirmMoney? }`
 * or `{ key, reset: true, note?, confirmMoney? }`.
 */
export async function changeConfig(
  d1: D1WithBatch,
  body: unknown,
  by: string,
): Promise<{ ok: true; row: ConfigRow } | { ok: false; error: string }> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const opts: WriteOpts = {
    note: (b.note as string | null | undefined) ?? null,
    confirmMoney: b.confirmMoney === true,
  };
  try {
    const row =
      b.reset === true
        ? await resetConfig(d1, b.key, by, opts)
        : await setConfig(d1, b.key, b.value, by, opts);
    return { ok: true, row };
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, error: e.message };
    throw e;
  }
}
