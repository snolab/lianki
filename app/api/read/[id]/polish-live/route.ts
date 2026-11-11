import { NextResponse } from "next/server";
import {
  LIVE_POLISH_CONTEXT_CHARS,
  LIVE_POLISH_MAX_CHARS,
  LIVE_POLISH_MAX_PASSAGES,
} from "@/lib/read/live-polish";
import { livePolishAi, mayPolishLive } from "@/lib/read/live-polish-server";
import { polishRefused } from "@/lib/read/polish-offer";
import { badRequest, bodyOf, json, readerCtx, payerOf } from "@/lib/read/reader-route";
import { isRefused, refusalOf } from "@/lib/payments/metered";

/**
 * POST /api/read/[id]/polish-live — passages of a live doc as a speech draft
 * (lib/read/live-polish.ts; docs/connections.md, "Polish"):
 *
 *   { passages: string[], before? }  → { passages: ({ text, thin } | null)[] }
 *
 * One answer per passage, in order. null: it has no counterpart, thin: its edit
 * is much shorter than it. The reader flags both and keeps the original.
 *
 * Stores nothing and changes no book: the raw text stays the book's. The flag
 * `read.live-polish`, or the owner; 404 to anyone else. 400 bad input · 429 over
 * the limit · 502 the model failed · 503 Workers AI not configured.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  if (!(await mayPolishLive(ctx.email))) return json({ error: "not-found" }, 404);
  if (polishRefused((await ctx.load()).words.book)) return badRequest("not offered");
  const body = (await bodyOf(req)) as { passages?: unknown; before?: unknown } | null;
  const passages = body?.passages;
  if (
    !Array.isArray(passages) ||
    !passages.length ||
    passages.length > LIVE_POLISH_MAX_PASSAGES ||
    !passages.every((p) => typeof p === "string" && p.trim())
  )
    return badRequest("passages are required");
  if (passages.join("").length > LIVE_POLISH_MAX_CHARS) return badRequest("too long");
  const before =
    typeof body?.before === "string" ? body.before.slice(-LIVE_POLISH_CONTEXT_CHARS) : "";
  const r = await livePolishAi(passages as string[], before, payerOf(ctx));
  if (r.ok) return json({ passages: r.passages });
  if (isRefused(r)) return refusalOf(r);
  const status = { busy: 429, "model-failed": 502, "not-configured": 503 }[r.error];
  return json({ error: r.error }, status);
}
