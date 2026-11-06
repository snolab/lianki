// A /vibe line through the reader's own translate path (docs/vibe.md,
// "Translations"): the same model, limiter and charge (lib/read/translate-server.ts).
// What differs is the cache. Speech does not go into the shared read_translation:
// it stays in vibe_translation, with its doc, and goes when the doc goes.
import { getReadMaterialById } from "@/lib/getReadMaterialsCollection";
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
  userId: string,
  id: string,
  input: { text: string; to: string; from: string | null },
  now: number,
  complete?: Complete,
): Promise<LineResult> {
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
      limit: AI_LIMIT_LIVE,
      what: "vibe.translate",
      ...(complete ? { complete } : {}),
      cache: {
        get: async () =>
          (
            await db
              .prepare(
                "SELECT out FROM vibe_translation WHERE doc_id = ? AND target = ? AND line = ?",
              )
              .bind(id, input.to, line)
              .first<{ out: string }>()
          )?.out ?? null,
        put: async (_key, out, model) => {
          await db
            .prepare(
              `INSERT INTO vibe_translation (doc_id, target, line, out, model, created_ms)
               VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(doc_id, target, line) DO NOTHING`,
            )
            .bind(id, input.to, line, out, model, now)
            .run();
        },
      },
    },
  );
}

/** What a log page opens with. */
export async function docTranslations(db: D1Batch, id: string) {
  const { results } = await db
    .prepare("SELECT line, target, out FROM vibe_translation WHERE doc_id = ?")
    .bind(id)
    .all<{ line: string; target: string; out: string }>();
  return results ?? [];
}
