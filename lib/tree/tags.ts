/**
 * Tag conventions for nodes (docs/calendar-plan.md, "Tags and views, not
 * types"). A node has no type: its tags say what it is for, and `fields`
 * holds whatever it needs. This file documents the known keys per tag and
 * checks them softly: a known key with the wrong type is dropped, unknown
 * keys are kept as they are. A new tag or key is a code change here only —
 * never a migration.
 */

type FieldKind = "number" | "string" | "day" | "days";

/** Known `fields` keys per tag. */
export const TAG_FIELDS: Record<string, Record<string, FieldKind>> = {
  /** The root of a study plan (one per user, made on first use). */
  plan: {},
  /** Something to reach. */
  goal: { targetDate: "day", metric: "string" },
  /** A recurring practice. `days`: weekdays, "MO".."SU". */
  habit: { minutesPerDay: "number", days: "days", listId: "string", newPerDay: "number" },
  /** A one-off action. */
  todo: { due: "day" },
  /** Free text. */
  note: { body: "string" },
  /** A study block (it also has a time facet). */
  session: { covers: "string" },
};

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_FIELDS_BYTES = 8 * 1024;

const WEEKDAYS = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

function fits(kind: FieldKind, v: unknown): boolean {
  switch (kind) {
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "string":
      return typeof v === "string";
    case "day":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    case "days":
      return Array.isArray(v) && v.every((d) => typeof d === "string" && WEEKDAYS.has(d));
  }
}

/** Lower-cased, trimmed, unique tags; drops empties and anything too long. */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const s = t.trim().toLowerCase();
    if (!s || s.length > MAX_TAG_LENGTH || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * `fields` checked against the known keys of the node's tags. Returns null when
 * it is not a plain object or is over MAX_FIELDS_BYTES (the caller rejects).
 */
export function checkFields(fields: unknown, tags: string[]): Record<string, unknown> | null {
  if (fields == null) return {};
  if (typeof fields !== "object" || Array.isArray(fields)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
    const kind = tags.map((t) => TAG_FIELDS[t]?.[k]).find(Boolean);
    if (kind && !fits(kind, v)) continue;
    out[k] = v;
  }
  if (new TextEncoder().encode(JSON.stringify(out)).length > MAX_FIELDS_BYTES) return null;
  return out;
}
