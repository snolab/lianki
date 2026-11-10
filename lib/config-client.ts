/**
 * Public config values in the browser (docs/config-store.md). The app layout
 * reads the public keys on the server (lib/config-store.ts `publicConfig`) and
 * renders <PublicConfig values>, which hands them here before any page below it
 * renders; `publicCfg(key)` then reads them anywhere, React or not.
 *
 * Until then (a page outside the app layout, a unit test), and for a value
 * that does not pass its schema, the registry default is used. Values are
 * global, not per user, so the server render and the browser agree.
 */
import {
  CONFIG,
  isConfigKey,
  parseConfigValue,
  type ConfigValue,
  type PublicConfigKey,
  type PublicConfigValues,
} from "./config";

let snapshot: Partial<Record<PublicConfigKey, unknown>> = {};

/** Take the server's public values; keys that are not public, or not valid, are dropped. */
export function setPublicConfig(values: Partial<PublicConfigValues> | null | undefined): void {
  const next: Partial<Record<PublicConfigKey, unknown>> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!isConfigKey(k) || CONFIG[k].audience !== "public") continue;
    const r = parseConfigValue(k, v);
    if (r.ok) next[k as PublicConfigKey] = r.value;
  }
  snapshot = next;
}

/** A public key's value: the server's, or the registry default. */
export function publicCfg<K extends PublicConfigKey>(key: K): ConfigValue<K> {
  return (snapshot[key] ?? CONFIG[key].default) as ConfigValue<K>;
}
