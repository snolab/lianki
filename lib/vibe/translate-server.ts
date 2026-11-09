// A /vibe line through the reader's own translate path (docs/vibe.md,
// "Translations"): the same model, limiter and charge (lib/read/translate-server.ts).
// What differs is the cache. Speech does not go into the shared read_translation:
// it stays in vibe_translation, with its doc, and goes when the doc goes. A
// selection in /read on one of these docs comes the same way (translateSelection).
import { getReadMaterialById, type ReadMaterial } from "@/lib/getReadMaterialsCollection";
import type { D1Batch } from "@/lib/read/reader-store";
import { AI_LIMIT_LIVE, translate, type TranslateResult } from "@/lib/read/translate-server";
import type { Complete } from "@/lib/read/gloss-server";
import { cleanLine, type VibeState } from "./store";

export type LineResult =
  | TranslateResult
  | { ok: false; error: "not-found" | "paused" | "not-a-line" };

/**
 * Only a finished line of this user's own conversation, and never while it is
 * paused. A line already translated answers from its doc, with no model and no charge.
 */
export async function translateLine(
  db: D1Batch,
  who: string | { userId: string; email?: string | null },
  id: string,
  input: { text: string; to: string; from: string | null },
  now: number,
  complete?: Complete,
): Promise<LineResult> {
  const { userId, email = null } = typeof who === "string" ? { userId: who } : who;
  const doc = await db
    .prepare("SELECT material_id, status FROM vibe_doc WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ material_id: string | null; status: VibeState }>();
  if (!doc?.material_id) return { ok: false, error: "not-found" };
  if (doc.status === "paused") return { ok: false, error: "paused" };
  const line = cleanLine(input.text);
  const m = await getReadMaterialById(userId, doc.material_id);
  if (!line || !m?.lines.includes(line)) return { ok: false, error: "not-a-line" };
  return translate(
    db,
    { text: line, to: input.to, from: input.from },
    {
      userId,
      email,
      db,
      limit: AI_LIMIT_LIVE,
      what: "vibe.translate",
      ...(complete ? { complete } : {}),
      cache: lineCache(db, id, input.to, line, now),
    },
  );
}

/** One line's row in its doc. */
const lineCache = (db: D1Batch, id: string, to: string, line: string, now: number) => ({
  get: async () =>
    (
      await db
        .prepare("SELECT out FROM vibe_translation WHERE doc_id = ? AND target = ? AND line = ?")
        .bind(id, to, line)
        .first<{ out: string }>()
    )?.out ?? null,
  put: async (_key: string, out: string, model: string) => {
    await db
      .prepare(
        `INSERT INTO vibe_translation (doc_id, target, line, out, model, created_ms)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(doc_id, target, line) DO NOTHING`,
      )
      .bind(id, to, line, out, model, now)
      .run();
  },
});

/** Nothing kept: the piece goes to the model and back, and the tab holds the answer. */
const NO_CACHE = { get: async () => null, put: async () => {} };

/**
 * A selection in /read on a /vibe doc (POST /api/read/[id]/translate): never the
 * shared read_translation. vibe_translation holds whole lines, so a selection that
 * is one uses that line's row, and pays for it once, here or on the log. Anything
 * else (a sentence of a longer line, a phrase) is not stored at all, and neither
 * is an answer with translator's notes: a line's row is its plain translation, the
 * one the log shows. `material` is the signed-in user's own (readerCtx); the doc is
 * asked for under the same user.
 */
export async function translateSelection(
  db: D1Batch,
  who: string | { userId: string; email?: string | null },
  material: Pick<ReadMaterial, "_id" | "lines">,
  input: { text: string; to: string; from: string | null; notes?: boolean },
  ai: { limit?: { windowMs: number; max: number }; complete?: Complete },
  now: number,
): Promise<TranslateResult> {
  const { userId, email = null } = typeof who === "string" ? { userId: who } : who;
  const doc = await db
    .prepare("SELECT id FROM vibe_doc WHERE material_id = ? AND user_id = ?")
    .bind(String(material._id), userId)
    .first<{ id: string }>();
  const line = cleanLine(input.text);
  const docId = doc && !input.notes && material.lines.includes(line) ? doc.id : null;
  return translate(db, docId ? { ...input, text: line } : input, {
    userId,
    email,
    db,
    what: "vibe.translate",
    ...ai,
    cache: docId ? lineCache(db, docId, input.to, line, now) : NO_CACHE,
  });
}

/** What a log page opens with. */
export async function docTranslations(db: D1Batch, id: string) {
  const { results } = await db
    .prepare("SELECT line, target, out FROM vibe_translation WHERE doc_id = ?")
    .bind(id)
    .all<{ line: string; target: string; out: string }>();
  return results ?? [];
}
