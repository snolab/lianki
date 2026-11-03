import { NextResponse } from "next/server";
import { json, lineRange, readerCtx } from "@/lib/read/reader-route";
import { notesInLines, reviewsInLines } from "@/lib/read/reader-store";
import type { HistoryResponse } from "@/lib/read/reader-api";

/** GET /api/read/[id]/history?from=&to= — every read (grade) and note on lines [from, to). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const [from, to] = lineRange(new URL(req.url), ctx.material.lines.length);
  const [reviews, notes] = await Promise.all([
    reviewsInLines(ctx.db, ctx.userId, ctx.ref.bookHash, from, to),
    notesInLines(ctx.db, ctx.userId, ctx.ref.bookHash, from, to),
  ]);
  return json<HistoryResponse>({ reviews, notes });
}
