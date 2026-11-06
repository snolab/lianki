import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { LIVE_POLISH_CONTEXT_CHARS, LIVE_POLISH_MAX_CHARS } from "@/lib/read/live-polish";
import { livePolishAi } from "@/lib/read/live-polish-server";
import { badRequest, bodyOf, json, readerCtx } from "@/lib/read/reader-route";

/**
 * POST /api/read/[id]/polish-live — a passage of a live doc as a speech draft
 * (lib/read/live-polish.ts; docs/connections.md, "Polish"):
 *
 *   { text, before? }  → { text }
 *
 * Stores nothing and changes no book: the raw text stays the book's. The flag
 * `read.live-polish`, or the owner; 404 to anyone else. 400 bad input · 429 over
 * the limit · 502 the model failed · 503 Workers AI not configured.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!(isOwner(session?.user?.email ?? null) || flagIn(await readFlags(), "read.live-polish")))
    return json({ error: "Not found" }, 404);
  const body = (await bodyOf(req)) as { text?: unknown; before?: unknown } | null;
  if (typeof body?.text !== "string" || !body.text.trim()) return badRequest("text is required");
  if (body.text.length > LIVE_POLISH_MAX_CHARS) return badRequest("text is too long");
  const before =
    typeof body.before === "string" ? body.before.slice(-LIVE_POLISH_CONTEXT_CHARS) : "";
  const r = await livePolishAi(body.text, before, { userId: ctx.userId });
  if (r.ok) return json({ text: r.text });
  const status = { busy: 429, "model-failed": 502, "not-configured": 503 }[r.error];
  return json({ error: r.error }, status);
}
