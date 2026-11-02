/**
 * Shared state between islands (docs/dev-hot-islands.md): JSON in
 * localStorage under `lk:s:<key>`, stored as `{v, data}`, every key listed
 * with its zod schema, default and version in contract.ts.
 *
 * - Reads never throw: a missing, unparsable, older-and-unmigratable or
 *   invalid value reads as the key's default (and is logged to the devLog).
 * - Writes go through `schema.parse`, then notify: other tabs through the
 *   `storage` event, this tab through the CustomEvent `lk:shared-state`
 *   ({key}), since `storage` never fires in the writing tab.
 * - Blocked storage (private mode, sandbox) falls back to memory, per key.
 * - SSR-safe: the server and the first client render see the default.
 *
 * No module state other than a cache and the memory fallback, so a remote
 * island's own copy of this file works with the page's.
 */
import { useSyncExternalStore } from "react";
import { devLog } from "@/lib/debug-client";
import { SHARED, type SharedEntry, type SharedKey, type SharedValue } from "./contract";

export const SHARED_EVENT = "lk:shared-state";
export const SHARED_PREFIX = "lk:s:";

type Log = (event: Record<string, unknown>) => void;

/** A stored value, decoded against its entry; never throws. */
export function decodeShared<T>(
  key: string,
  e: SharedEntry<T>,
  raw: string | null,
  log: Log = devLog,
): T {
  if (raw === null) return e.default;
  const bad = (why: string) => {
    log({ ev: "shared-state-default", key, why: why.slice(0, 200) });
    return e.default;
  };
  let stored: { v?: unknown; data?: unknown };
  try {
    stored = JSON.parse(raw);
  } catch {
    return bad("not JSON");
  }
  if (!stored || typeof stored !== "object") return bad("not {v, data}");
  let data = stored.data;
  const v = stored.v;
  if (v !== e.version) {
    if (typeof v !== "number" || v > e.version || !e.migrate)
      return bad(`version ${String(v)}, want ${e.version}`);
    try {
      data = e.migrate(v, data);
    } catch (err) {
      return bad(`migrate from ${v} threw: ${String(err)}`);
    }
  }
  const r = e.schema.safeParse(data);
  return r.success ? r.data : bad(r.error.message);
}

/** The JSON to store for a value: parsed by the schema first (throws on a bad write). */
export const encodeShared = <T>(e: SharedEntry<T>, value: T) =>
  JSON.stringify({ v: e.version, data: e.schema.parse(value) });

/** Keys whose storage failed: kept in memory for this page instead. */
const memory = new Map<string, string | null>();

function rawGet(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    return localStorage.getItem(SHARED_PREFIX + key);
  } catch {
    return null;
  }
}

function rawSet(key: string, json: string | null) {
  try {
    if (json === null) localStorage.removeItem(SHARED_PREFIX + key);
    else localStorage.setItem(SHARED_PREFIX + key, json);
    memory.delete(key);
  } catch {
    memory.set(key, json);
  }
}

/** Last decoded value per key, so a snapshot is stable until the raw text changes. */
const cache = new Map<string, { raw: string | null; value: unknown }>();

/** The current value of a shared key (the default on the server). */
export function readShared<K extends SharedKey>(key: K): SharedValue<K> {
  const e = SHARED[key] as SharedEntry<SharedValue<K>>;
  if (typeof window === "undefined") return e.default;
  const raw = rawGet(key);
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as SharedValue<K>;
  const value = decodeShared(key, e, raw);
  cache.set(key, { raw, value });
  return value;
}

/** Write a shared key (parsed by its schema) and tell every island, here and in other tabs. */
export function writeShared<K extends SharedKey>(
  key: K,
  next: SharedValue<K> | ((prev: SharedValue<K>) => SharedValue<K>),
) {
  const e = SHARED[key] as SharedEntry<SharedValue<K>>;
  const value =
    typeof next === "function"
      ? (next as (p: SharedValue<K>) => SharedValue<K>)(readShared(key))
      : next;
  rawSet(key, encodeShared(e, value));
  window.dispatchEvent(new CustomEvent(SHARED_EVENT, { detail: { key } }));
}

/** Back to the default (removes the stored value). */
export function clearShared(key: SharedKey) {
  rawSet(key, null);
  window.dispatchEvent(new CustomEvent(SHARED_EVENT, { detail: { key } }));
}

/** Call `cb` when `key` changes, in this tab or another. Returns the unsubscribe. */
export function subscribeShared(key: SharedKey, cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === SHARED_PREFIX + key) cb();
  };
  const onLocal = (e: Event) => {
    if ((e as CustomEvent<{ key?: string }>).detail?.key === key) cb();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(SHARED_EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SHARED_EVENT, onLocal);
  };
}

type Setter<K extends SharedKey> = (
  next: SharedValue<K> | ((prev: SharedValue<K>) => SharedValue<K>),
) => void;

/** Stable per-key functions for useSyncExternalStore (made once, never per render). */
const bound = new Map<
  SharedKey,
  {
    subscribe: (cb: () => void) => () => void;
    snapshot: () => unknown;
    server: () => unknown;
    set: Setter<SharedKey>;
  }
>();
export function boundShared<K extends SharedKey>(key: K) {
  let b = bound.get(key);
  if (!b) {
    b = {
      subscribe: (cb) => subscribeShared(key, cb),
      snapshot: () => readShared(key),
      server: () => SHARED[key].default,
      set: (next) => writeShared(key, next as Parameters<Setter<K>>[0]),
    };
    bound.set(key, b);
  }
  return b as unknown as {
    subscribe: (cb: () => void) => () => void;
    snapshot: () => SharedValue<K>;
    server: () => SharedValue<K>;
    set: Setter<K>;
  };
}

/**
 * One shared key as React state: `[value, set]`. Every island using the key,
 * in every tab, re-renders when it changes.
 */
export function useSharedState<K extends SharedKey>(key: K): [SharedValue<K>, Setter<K>] {
  const b = boundShared(key);
  return [useSyncExternalStore(b.subscribe, b.snapshot, b.server), b.set];
}
