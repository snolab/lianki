// SQL generation for the MongoDB -> D1 migration.
// Pure functions — no DB connection — so they can be unit tested.

/** Render a JS value as a SQLite literal. Objects/arrays become JSON strings. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Date) return quote(value.toISOString());
  if (typeof value === "string") return quote(value);
  // object / array -> JSON text
  return quote(JSON.stringify(value, jsonDateReplacer));
}

function jsonDateReplacer(_key: string, val: unknown): unknown {
  return val instanceof Date ? val.toISOString() : val;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Build an `INSERT OR REPLACE` statement. Column order follows the keys of
 * `row`; callers must pass rows whose keys match the target table columns.
 */
export function buildInsert(table: string, row: Record<string, unknown>): string {
  const cols = Object.keys(row);
  if (cols.length === 0) throw new Error(`buildInsert: empty row for ${table}`);
  const colList = cols.join(", ");
  const valList = cols.map((c) => sqlLiteral(row[c])).join(", ");
  return `INSERT OR REPLACE INTO ${table} (${colList}) VALUES (${valList});`;
}

/** Build many INSERT statements for one table, one row per line. */
export function buildInserts(table: string, rows: Record<string, unknown>[]): string {
  return rows.map((r) => buildInsert(table, r)).join("\n");
}
