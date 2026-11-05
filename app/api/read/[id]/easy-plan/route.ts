import { NextResponse } from "next/server";
import {
  badRequest,
  bodyOf,
  bookCtxOf,
  json,
  rangeWords,
  readerCtx,
} from "@/lib/read/reader-route";
import { planWords } from "@/lib/read/batch-grade-server";

/**
 * POST /api/read/[id]/easy-plan — which of an item's words an Easy grade
 * would grade now (due, new, or no card yet; the batch path's own filter),
 * read-only:
 *
 *   { words: [{ w, ex, term?, reading?, back? }] }  → { words: [w, …] }
 *
 * The swipe's hint counts them ("Easy + N words Easy"), and any other grade
 * opens the item's word review only when there is one (ReaderV2).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.email) return json({ words: [] });
  const body = (await bodyOf(req)) as { words?: unknown } | null;
  const { book: bctx, own } = await bookCtxOf(ctx);
  const words = rangeWords(body?.words, own);
  if (!words) return badRequest("words are required");
  return json({
    words: await planWords({ db: ctx.db, email: ctx.email, bctx }, words, new Date()),
  });
}
