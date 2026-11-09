/**
 * The column-mapping step of the word-list import (docs/import-material.md,
 * "Column mapping"): which file column goes into which field of a /words
 * card. Pure, shared by the page (the chips and the live preview) and the
 * server (the commit parses with the mapping the page sends).
 *
 * A mapping is a slot per field holding file columns in order. Two columns in
 * one slot are joined in that order (two meaning columns → "a; b"). A column
 * in no slot is ignored. The defaults come from the header aliases
 * (HEADER_ALIASES, lib/import/wordlist.ts) or, without a header, the column
 * order; `MAPPING_GUESSERS` is the hook for smarter, content-based guesses
 * (not built: owner scope, 2026-11-10).
 */
import type { Role } from "@/lib/words/anki";

/** The fields a column can fill, in the order the slots are shown. */
export const SLOTS = ["term", "back", "ex", "reading", "exTr"] as const satisfies readonly Role[];
export type Slot = (typeof SLOTS)[number];

/** File columns per field, in order; a column in none is ignored. */
export type ColumnMapping = Record<Slot, number[]>;

/** Most columns a mapping may name (a word list never has this many). */
export const MAX_COLUMNS = 64;
/** What joins two columns in one slot. */
export const JOIN = "; ";

export const emptyMapping = (): ColumnMapping => ({
  term: [],
  back: [],
  ex: [],
  reading: [],
  exTr: [],
});

/** A detected `columns` record (one index per role, -1 = none) as a mapping. */
export function fromColumns(columns: Record<Role, number>, width: number): ColumnMapping {
  const m = emptyMapping();
  for (const s of SLOTS) {
    const i = columns[s];
    if (i >= 0 && i < width) m[s] = [i];
  }
  return m;
}

/** The columns no slot holds, in file order (the "ignore" pile). */
export function ignored(m: ColumnMapping, width: number): number[] {
  const used = new Set(SLOTS.flatMap((s) => m[s]));
  return Array.from({ length: width }, (_, i) => i).filter((i) => !used.has(i));
}

/**
 * A mapping as it may be trusted: indices inside the table, each column in at
 * most one slot (the first one that names it), slots in SLOTS only. Null when
 * the input is not a mapping at all.
 */
export function cleanMapping(v: unknown, width: number): ColumnMapping | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = emptyMapping();
  const seen = new Set<number>();
  for (const s of SLOTS) {
    const cols = (v as Record<string, unknown>)[s];
    if (cols === undefined) continue;
    if (!Array.isArray(cols)) return null;
    for (const c of cols) {
      if (!Number.isInteger(c) || c < 0 || c >= Math.min(width, MAX_COLUMNS) || seen.has(c))
        continue;
      seen.add(c);
      out[s].push(c);
    }
  }
  return out;
}

/** A cell's text for a slot: its columns' cells, trimmed, joined in order; "" when none. */
export function slotText(cells: readonly string[], cols: readonly number[]): string {
  return cols
    .map((i) => (cells[i] ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(JOIN);
}

/** Where a column is: a slot, or null (ignored). */
export function slotOf(m: ColumnMapping, col: number): Slot | null {
  for (const s of SLOTS) if (m[s].includes(col)) return s;
  return null;
}

/**
 * Move a column into `to` (null = ignore) at `index` within it (default: the
 * end). Moving within the same slot reorders it. Pure: a new mapping.
 */
export function moveColumn(
  m: ColumnMapping,
  col: number,
  to: Slot | null,
  index?: number,
): ColumnMapping {
  const out = emptyMapping();
  for (const s of SLOTS) out[s] = m[s].filter((c) => c !== col);
  if (to) {
    const list = out[to];
    const at = index === undefined ? list.length : Math.max(0, Math.min(list.length, index));
    list.splice(at, 0, col);
  }
  return out;
}

/** What a guesser sees: the header's cells (if any) and the first rows. */
export interface TableShape {
  header: string[] | null;
  rows: string[][];
  width: number;
}

/**
 * A guess at the mapping from the table's content, or null for no opinion.
 * The hook for content-based guessing (a column of short tokens = words, of
 * sentences = examples…): none is registered yet.
 */
export type MappingGuesser = (t: TableShape, fallback: ColumnMapping) => ColumnMapping | null;
export const MAPPING_GUESSERS: MappingGuesser[] = [];

/** The default mapping: the aliases' (`fallback`), unless a registered guesser knows better. */
export function guessMapping(
  t: TableShape,
  fallback: ColumnMapping,
  guessers: readonly MappingGuesser[] = MAPPING_GUESSERS,
): ColumnMapping {
  for (const g of guessers) {
    const m = g(t, fallback);
    const clean = m && cleanMapping(m, t.width);
    if (clean && clean.term.length) return clean;
  }
  return fallback;
}

/** Two mappings the same. */
export function sameMapping(a: ColumnMapping, b: ColumnMapping): boolean {
  return SLOTS.every((s) => a[s].length === b[s].length && a[s].every((c, i) => b[s][i] === c));
}
