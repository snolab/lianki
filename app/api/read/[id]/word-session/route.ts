import { NextResponse } from "next/server";
import {
  badRequest,
  bodyOf,
  bookCtxOf,
  json,
  rangeWords,
  readerCtx,
} from "@/lib/read/reader-route";
import { addGradedEntries, scopeSession, type RangeWord } from "@/lib/read/book-word-list";
import { fillGlosses } from "@/lib/read/gloss-server";

/**
 * POST /api/read/[id]/word-session — the review of a range's words in /words'
 * own list review (docs/books-plan.md, "Review a range's words"):
 *
 *   { words: [{ w, ex, term?, reading?, back? }] }            → { items, lists, missing }
 *   { graded: [{ w, ex, term?, reading?, back? }] }           → { added }
 *
 * `items`: each word on his existing card (any of his lists in the book's
 * language, lib/read/word-review.ts matchCard) or as a new word of the
 * book's list; grades then go through /api/words/lists/<id>/review as on
 * /words. `graded`: new words just graded join the book list's entries.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.email) return badRequest("no email");
  const body = (await bodyOf(req)) as { words?: unknown; graded?: unknown } | null;
  const { book, own } = await bookCtxOf(ctx);
  if (body?.graded !== undefined) {
    const graded = rangeWords(body.graded, own);
    if (!graded) return badRequest("graded words are required");
    const glossed = await fillGlosses(ctx.db, book, graded, null);
    return json({ added: await addGradedEntries(ctx.db, ctx.email, book, glossed) });
  }
  const words = rangeWords(body?.words, own);
  if (!words) return badRequest("words are required");
  // A meaning for every word lacking one: the decks over the book's lemmas,
  // the generated glosses, the model (lib/read/gloss.ts).
  const gloss = (ws: RangeWord[]) => fillGlosses(ctx.db, book, ws, { userId: ctx.userId });
  return json(await scopeSession(ctx.db, ctx.email, book, words, gloss));
}
