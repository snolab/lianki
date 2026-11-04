import { NextResponse } from "next/server";
import {
  badRequest,
  bodyOf,
  bookCtxOf,
  json,
  rangeWords,
  readerCtx,
} from "@/lib/read/reader-route";
import { easyPlan, planWords } from "@/lib/read/book-word-list";

/**
 * POST /api/read/[id]/easy-plan — which of an item's words an Easy grade
 * would grade now (due on his card, or no card yet), read-only:
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
  const { book, own } = await bookCtxOf(ctx);
  const words = rangeWords(body?.words, own);
  if (!words) return badRequest("words are required");
  return json({ words: planWords(await easyPlan(ctx.db, ctx.email, book, words)) });
}
