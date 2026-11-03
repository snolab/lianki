import { NextResponse } from "next/server";
import { json, readerCtx } from "@/lib/read/reader-route";
import { dueFor } from "@/lib/read/reader-service";

/** GET /api/read/[id]/due — sentences due now, in reading order: where to take the reader back to. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const { book } = await ctx.load();
  return json(await dueFor(ctx.db, ctx.ref, book, new Date()));
}
