import { NextResponse } from "next/server";
import { badRequest, bodyOf, json, readerCtx } from "@/lib/read/reader-route";
import { MAX_TRANSLATE_CHARS, langTag } from "@/lib/read/translate";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { AI_LIMIT_LIVE, translate } from "@/lib/read/translate-server";

/**
 * POST /api/read/[id]/translate — the reader's Translate: the selected text
 * in the learner's language, on the selection card (lib/read/translate.ts).
 *
 *   { text, to, from?, notes? }  → { text, cached }
 *
 * `notes: true`: the text may hold translator's notes in ⟦ ⟧, cached apart
 * (lib/read/translate.ts).
 *
 * 400 bad input · 429 over the per-user limit · 502 the model failed ·
 * 503 Workers AI not configured. Logs never carry the text.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const body = (await bodyOf(req)) as {
    text?: unknown;
    to?: unknown;
    from?: unknown;
    notes?: unknown;
  } | null;
  const to = langTag(body?.to);
  if (!to) return badRequest("to is required");
  if (typeof body?.text !== "string" || !body.text.trim()) return badRequest("text is required");
  if (body.text.length > MAX_TRANSLATE_CHARS) return badRequest("text is too long");
  const from = langTag(body.from);
  // Who may read a live doc: its card follows every new sentence.
  const live = isOwner(ctx.email) || flagIn(await readFlags(), "read.gdoc-stream");
  const r = await translate(
    ctx.db,
    { text: body.text, to, from, notes: body.notes === true },
    { userId: ctx.userId, ...(live ? { limit: AI_LIMIT_LIVE } : {}) },
  );
  if (r.ok) return json({ text: r.text, cached: r.cached });
  const status = { empty: 400, busy: 429, "model-failed": 502, "not-configured": 503 }[r.error];
  return json({ error: r.error }, status);
}
