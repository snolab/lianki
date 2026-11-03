import { NextResponse } from "next/server";
import { json, readerCtx, wordCtx } from "@/lib/read/reader-route";
import { familiarityFor } from "@/lib/read/reader-service";

/** GET /api/read/[id]/familiarity — per chapter and for the book, with the reader-v2 pass. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const { book, w } = await wordCtx(ctx);
  return json(await familiarityFor(ctx.db, ctx.ref, book, w));
}
