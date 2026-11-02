/**
 * localStorage keys for the chat feature. Users see it as the learning
 * partner (docs/dev-debug-widget.md, "Naming"); the code calls it "debug",
 * and the keys used to be `lk:debug*`. They are moving to `lk:agent*`:
 *
 * - reads try the `lk:agent*` key first, then the `lk:debug*` one; when both
 *   are set and differ, the one written since the last read wins (getKey);
 * - writes go to both, so a rollback to the previous release still sees them;
 * - `migrateKeys` copies every `lk:debug*` key to its `lk:agent*` twin once
 *   per device and keeps the old keys (drop them one release later).
 *
 * Callers pass the legacy name (`lk:debug-chat-open`); `agentKey` maps it.
 */

export const LEGACY_PREFIX = "lk:debug";
export const AGENT_PREFIX = "lk:agent";
/** Set once the copy has run on this device. */
export const MIGRATED_KEY = "lk:agent-migrated";

/** The subset of Storage these helpers need (tests pass a plain object). */
export type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** `lk:debug-chat-open` → `lk:agent-chat-open`; other keys pass through. */
export function agentKey(legacy: string): string {
  return legacy.startsWith(LEGACY_PREFIX)
    ? AGENT_PREFIX + legacy.slice(LEGACY_PREFIX.length)
    : legacy;
}

const local = (): KeyStore | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/**
 * The pair of values each key had when last read (`{legacy: [agent, legacy]}`),
 * so a read can tell which of two differing values was written since.
 */
export const SEEN_KEY = "lk:agent-seen";

/** Keys whose two values differ with nothing to tell which is newer (logged once a page). */
const unresolved = new Set<string>();

/**
 * The value under the new key, else under the legacy one. setKey writes both,
 * so two differing values mean one was written by hand (or by an older
 * release): the one that changed since the last read wins, and is copied to
 * the other name, so they agree again. With no earlier read to compare, the
 * new name wins, as before.
 */
export function getKey(legacy: string, store: KeyStore | null = local()): string | null {
  if (!store) return null;
  try {
    const a = store.getItem(agentKey(legacy));
    const l = store.getItem(legacy);
    if (a === l || l === null || a === null) {
      if (a !== null || l !== null) see(store, legacy, a, l);
      return a ?? l;
    }
    const was = seen(store)[legacy];
    // The legacy value changed since, the new one did not: the legacy one is newer.
    const pick = was && was[0] === a && was[1] !== l ? l : a;
    if (!was && !unresolved.has(legacy)) {
      unresolved.add(legacy);
      console.info(`[storage-keys] ${legacy}: both names set and differ; using ${agentKey(legacy)}`);
    }
    if (was) {
      try {
        store.setItem(agentKey(legacy), pick);
        store.setItem(legacy, pick);
      } catch {}
      see(store, legacy, pick, pick);
    } else see(store, legacy, a, l);
    return pick;
  } catch {
    return null;
  }
}

function seen(store: KeyStore): Record<string, [string | null, string | null]> {
  try {
    const v = JSON.parse(store.getItem(SEEN_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Best effort: a store that cannot be written (full, read-only) still reads. */
function see(store: KeyStore, legacy: string, a: string | null, l: string | null) {
  try {
    const all = seen(store);
    const was = all[legacy];
    if (was && was[0] === a && was[1] === l) return;
    all[legacy] = [a, l];
    store.setItem(SEEN_KEY, JSON.stringify(all));
  } catch {}
}

/** Write under both names (the legacy one stays for one release). */
export function setKey(legacy: string, value: string, store: KeyStore | null = local()) {
  if (!store) return;
  try {
    store.setItem(agentKey(legacy), value);
    store.setItem(legacy, value);
    see(store, legacy, value, value);
  } catch {}
}

export function removeKey(legacy: string, store: KeyStore | null = local()) {
  if (!store) return;
  try {
    store.removeItem(agentKey(legacy));
    store.removeItem(legacy);
  } catch {}
}

/** Whether a storage event is about this key, under either name. */
export const isKey = (changed: string | null, legacy: string) =>
  changed === legacy || changed === agentKey(legacy);

/**
 * Copy each `lk:debug*` key to its `lk:agent*` name, once per device. A new
 * key already set wins. The old keys stay. Returns how many were copied.
 */
export function migrateKeys(store: KeyStore | null = local()): number {
  if (!store) return 0;
  try {
    if (store.getItem(MIGRATED_KEY) === "1") return 0;
    const legacy: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(LEGACY_PREFIX)) legacy.push(k);
    }
    let copied = 0;
    for (const k of legacy) {
      const v = store.getItem(k);
      const to = agentKey(k);
      if (v === null || store.getItem(to) !== null) continue;
      store.setItem(to, v);
      copied++;
    }
    store.setItem(MIGRATED_KEY, "1");
    return copied;
  } catch {
    return 0;
  }
}

/** The page's on/off switch: `?agent=` wins over the older `?debug=`. */
export function queryFlag(search: string): string | null {
  const q = new URLSearchParams(search);
  return q.get("agent") ?? q.get("debug");
}
