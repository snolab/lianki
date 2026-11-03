import { NextResponse } from "next/server";
import { badRequest, json, readerCtx, wordCtx } from "@/lib/read/reader-route";
import { itemsFor, parseGranularity } from "@/lib/read/reader-service";

/**
 * GET /api/read/[id]/items?g=sentence|paragraph|time&from=<line>&to=<line>&seconds=<n>
 * Review items (runs of whole sentences sized by reading time) of the chapters
 * overlapping [from, to), with the user's state. Reader v2 (lib/read/reader-api.ts).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const granularity = parseGranularity(url.searchParams.get("g") ?? "paragraph");
  if (!granularity) return badRequest("bad granularity");
  const { book, w } = await wordCtx(ctx);
  const n = book.lines.length;
  const int = (k: string) => {
    const v = Number.parseInt(url.searchParams.get(k) ?? "", 10);
    return Number.isFinite(v) ? v : null;
  };
  const from = Math.max(0, Math.min(n - 1, int("from") ?? 0));
  const to = int("to");
  const seconds = Number.parseFloat(url.searchParams.get("seconds") ?? "");
  return json(
    await itemsFor(ctx.db, ctx.ref, book, w, {
      granularity,
      from,
      to: to === null ? null : Math.max(from + 1, Math.min(n, to)),
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
    }),
  );
}
