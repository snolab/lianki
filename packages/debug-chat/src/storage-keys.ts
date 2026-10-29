/**
 * localStorage keys for the chat feature. Users see it as the learning
 * partner (docs/dev-debug-widget.md, "Naming"); the code calls it "debug",
 * and the keys used to be `lk:debug*`. They are moving to `lk:agent*`:
 *
 * - reads try the `lk:agent*` key first, then the `lk:debug*` one;
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

/** The value under the new key, else under the legacy one. */
export function getKey(legacy: string, store: KeyStore | null = local()): string | null {
  if (!store) return null;
  try {
    return store.getItem(agentKey(legacy)) ?? store.getItem(legacy);
  } catch {
    return null;
  }
}

/** Write under both names (the legacy one stays for one release). */
export function setKey(legacy: string, value: string, store: KeyStore | null = local()) {
  if (!store) return;
  try {
    store.setItem(agentKey(legacy), value);
    store.setItem(legacy, value);
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
