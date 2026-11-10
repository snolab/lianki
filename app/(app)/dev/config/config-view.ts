/**
 * The /dev/config list, as pure functions (unit/config.test.ts): the rows in
 * their sections, how a value reads, and a draft parsed for the API.
 */
import { CONFIG, type ConfigDef } from "@/lib/config";
import type { ConfigLogEntry, ConfigRow } from "@/lib/config-store";

export interface ConfigGroup {
  id: string;
  rows: ConfigRow[];
  /** Rows whose live value differs from the default. */
  changed: number;
}

/** Same value, compared as JSON (numbers, texts, small objects). */
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Sections in the registry's order, rows in their registry order. */
export function groupConfigRows(rows: ConfigRow[]): ConfigGroup[] {
  const groups = new Map<string, ConfigGroup>();
  for (const r of rows) {
    const id = (CONFIG[r.key] as ConfigDef).group;
    const g = groups.get(id) ?? { id, rows: [], changed: 0 };
    g.rows.push(r);
    if (!sameValue(r.value, r.default)) g.changed++;
    groups.set(id, g);
  }
  return [...groups.values()];
}

/** A value with its unit: "8000 ms"; null (the default in the log) as `dflt`. */
export function formatValue(v: unknown, unit: string | undefined, dflt = "default"): string {
  if (v === null || v === undefined) return dflt;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return unit ? `${s} ${unit}` : s;
}

/** The typed text as the value to send: a number for a number key. */
export function draftValue(key: ConfigRow["key"], text: string): unknown {
  const d = (CONFIG[key] as ConfigDef).default;
  if (typeof d === "number") {
    const t = text.trim();
    return t === "" ? NaN : Number(t);
  }
  return text;
}

/** One key's changes, newest first. */
export const historyOf = (log: ConfigLogEntry[], key: string) => log.filter((e) => e.key === key);

/** Puts values into a string's {placeholders}. */
export const fill = (s: string, v: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
