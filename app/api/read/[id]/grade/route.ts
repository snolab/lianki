import { NextResponse } from "next/server";
import { badRequest, bodyOf, json, readerCtx, wordCtx } from "@/lib/read/reader-route";
import { gradeFor } from "@/lib/read/reader-service";
import type { GradeRequest } from "@/lib/read/reader-api";

/** POST /api/read/[id]/grade — one swipe: FSRS on each of the item's sentences. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const body = (await bodyOf(req)) as Partial<GradeRequest> | null;
  const { book, w } = await wordCtx(ctx);
  const r = await gradeFor(ctx.db, ctx.ref, book, w, body, new Date());
  return r.ok ? json(r.res) : badRequest(r.error);
}
