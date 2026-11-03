import { NextResponse } from "next/server";
import { badRequest, bodyOf, json, lineRange, readerCtx } from "@/lib/read/reader-route";
import { notesInLines } from "@/lib/read/reader-store";
import { noteFor } from "@/lib/read/reader-service";

type Params = { params: Promise<{ id: string }> };

/** GET /api/read/[id]/notes?from=&to= — notes on lines [from, to). */
export async function GET(req: Request, { params }: Params) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const [from, to] = lineRange(new URL(req.url), ctx.material.lines.length);
  return json({ notes: await notesInLines(ctx.db, ctx.userId, ctx.ref.bookHash, from, to) });
}

/** POST /api/read/[id]/notes — a note on an item (optionally on one read of it). */
export async function POST(req: Request, { params }: Params) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const { book } = await ctx.load();
  const r = await noteFor(ctx.db, ctx.ref, book, (await bodyOf(req)) as never, new Date());
  return r.ok ? json(r.note, 201) : badRequest(r.error);
}
