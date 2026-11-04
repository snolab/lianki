import { NextResponse } from "next/server";
import {
  badRequest,
  bodyOf,
  bookCtxOf,
  json,
  rangeWords,
  readerCtx,
} from "@/lib/read/reader-route";
import { makeCards, unmakeCards, type RangeWord } from "@/lib/read/book-word-list";
import { fillGlosses } from "@/lib/read/gloss-server";

/**
 * POST /api/read/[id]/make-cards — 制卡: a card in the book's own list for
 * every word of the range that has no card in any of his lists (never a
 * second card), or the undo of that:
 *
 *   { words: [{ w, ex, term?, reading?, back? }] }  → { listId, terms }
 *   { undo: [term, …] }                            → { removed }  (only cards still unreviewed)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.email) return badRequest("no email");
  const body = (await bodyOf(req)) as { words?: unknown; undo?: unknown } | null;
  if (body?.undo !== undefined) {
    if (!Array.isArray(body.undo) || body.undo.length > 400)
      return badRequest("terms are required");
    const terms = body.undo.filter((t): t is string => typeof t === "string" && t.length <= 200);
    return json({ removed: await unmakeCards(ctx.db, ctx.email, ctx.ref.bookHash, terms) });
  }
  const { book, own } = await bookCtxOf(ctx);
  const words = rangeWords(body?.words, own);
  if (!words) return badRequest("words are required");
  const gloss = (ws: RangeWord[]) => fillGlosses(ctx.db, book, ws, { userId: ctx.userId });
  return json(await makeCards(ctx.db, ctx.email, book, words, undefined, gloss));
}
