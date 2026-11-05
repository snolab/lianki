import type { D1Like } from "@/lib/d1/types";

/** One book the user imported from Google Docs (read_materials.source_key `gdoc:<id>`). */
export type GdocImport = {
  /** The book's id (/read/<id>). */
  id: string;
  /** The Google Docs document id. */
  docId: string;
  title: string;
  /** Last import or re-import (read_materials.updated_at), ISO. */
  syncedAt: string;
};

/** The most rows /connections lists. */
export const GDOC_IMPORTS_MAX = 200;

const DOC_ID = /^[A-Za-z0-9_-]{25,128}$/;

/**
 * The user's books imported from Google Docs, newest sync first
 * (docs/connections.md, "Imported docs"). Both ways in count: Drive and the
 * public link, since both key the book `gdoc:<id>`. A range on source_key
 * (`gdoc:` ≤ k < `gdoc;`, ';' being the character after ':') rather than
 * LIKE, so the (user_id, source_key) index is used and `_` is no wildcard.
 */
export async function listGdocImports(
  db: D1Like,
  userId: string,
  limit = GDOC_IMPORTS_MAX,
): Promise<GdocImport[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, source_key, updated_at FROM read_materials
       WHERE user_id = ? AND source_key >= 'gdoc:' AND source_key < 'gdoc;'
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(userId, Math.max(1, Math.min(limit, GDOC_IMPORTS_MAX)))
    .all<{ id: string; title: string; source_key: string; updated_at: string }>();
  return results.flatMap((r) => {
    const docId = r.source_key.slice("gdoc:".length);
    return DOC_ID.test(docId) ? [{ id: r.id, docId, title: r.title, syncedAt: r.updated_at }] : [];
  });
}
