// Pure functions for Lianki YAML export/import — no Next.js runtime required.

export const EXPORT_VERSION = "1";

function convertDates(obj: unknown): unknown {
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(convertDates);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, convertDates(v)]),
    );
  }
  return obj;
}

/** Strip _id and convert Date → ISO string for export. */
export function serializeNoteForExport(note: Record<string, unknown>): Record<string, unknown> {
  const { _id: _ignored, ...rest } = note;
  return convertDates(rest) as Record<string, unknown>;
}

/** Strip _id and convert Date → ISO string for export. */
export function serializeGoalForExport(goal: Record<string, unknown>): Record<string, unknown> {
  const { _id: _ignored, ...rest } = goal;
  return convertDates(rest) as Record<string, unknown>;
}

function toDate(val: unknown): Date | unknown {
  if (val instanceof Date) return val;
  if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
    return new Date(val);
  }
  return val;
}

/** Restore ISO date strings → Date objects for the FSRS card and log fields. */
export function restoreNoteFromExport(data: Record<string, unknown>): Record<string, unknown> {
  const card = data.card as Record<string, unknown> | undefined;
  const log = (data.log ?? []) as Record<string, unknown>[];
  return {
    ...data,
    ...(card && {
      card: {
        ...card,
        due: toDate(card.due),
        ...(card.last_review !== undefined && { last_review: toDate(card.last_review) }),
      },
    }),
    log: log.map((entry) => ({
      ...entry,
      due: toDate(entry.due),
      review: toDate(entry.review),
    })),
  };
}

/** Restore ISO date strings → Date objects for roadmap goal timestamps. */
export function restoreGoalFromExport(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
  };
}
