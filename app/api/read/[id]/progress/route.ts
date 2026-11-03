import { NextResponse } from "next/server";
import { badRequest, bodyOf, json, readerCtx } from "@/lib/read/reader-route";
import { getProgress, putProgress } from "@/lib/read/reader-store";
import type { ProgressPut } from "@/lib/read/reader-api";

type Params = { params: Promise<{ id: string }> };

/** GET /api/read/[id]/progress — the synced reading position and high-water line. */
export async function GET(_req: Request, { params }: Params) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  return json(await getProgress(ctx.db, ctx.userId, ctx.ref.materialId));
}

/**
 * PUT (or POST, for navigator.sendBeacon on pagehide) /api/read/[id]/progress.
 * Sent when scrolling stops and on pagehide; never on a timer.
 */
export async function PUT(req: Request, { params }: Params) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const b = (await bodyOf(req)) as Partial<ProgressPut> | null;
  const n = ctx.material.lines.length;
  const line = b?.line;
  const offset = b?.offset;
  if (!Number.isInteger(line) || (line as number) < 0 || (line as number) >= n)
    return badRequest("line out of range");
  if (typeof offset !== "number" || !(offset >= 0 && offset <= 1))
    return badRequest("offset must be 0..1");
  const high = b?.highLine;
  if (high !== undefined && (!Number.isInteger(high) || high < 0 || high >= n))
    return badRequest("highLine out of range");
  const now = new Date();
  // The client's time orders anchors; never later than now.
  let t = typeof b?.at === "string" ? Date.parse(b.at) : NaN;
  if (!Number.isFinite(t) || t > now.getTime()) t = now.getTime();
  return json(
    await putProgress(
      ctx.db,
      ctx.userId,
      ctx.ref.materialId,
      { line: line as number, offset, highLine: high, at: new Date(t).toISOString() },
      now,
    ),
  );
}

export const POST = PUT;
