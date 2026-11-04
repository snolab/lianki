import { NextResponse } from "next/server";
import { badRequest, bodyOf, json, readerCtx } from "@/lib/read/reader-route";
import { MAX_TRANSLATE_CHARS, langTag } from "@/lib/read/translate";
import { translate } from "@/lib/read/translate-server";

/**
 * POST /api/read/[id]/translate — the reader's Translate: the selected text
 * in the learner's language, on the selection card (lib/read/translate.ts).
 *
 *   { text, to, from? }  → { text, cached }
 *
 * 400 bad input · 429 over the per-user limit · 502 the model failed ·
 * 503 Workers AI not configured. Logs never carry the text.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const body = (await bodyOf(req)) as { text?: unknown; to?: unknown; from?: unknown } | null;
  const to = langTag(body?.to);
  if (!to) return badRequest("to is required");
  if (typeof body?.text !== "string" || !body.text.trim()) return badRequest("text is required");
  if (body.text.length > MAX_TRANSLATE_CHARS) return badRequest("text is too long");
  const from = langTag(body.from);
  const r = await translate(ctx.db, { text: body.text, to, from }, { userId: ctx.userId });
  if (r.ok) return json({ text: r.text, cached: r.cached });
  const status = { empty: 400, busy: 429, "model-failed": 502, "not-configured": 503 }[r.error];
  return json({ error: r.error }, status);
}
