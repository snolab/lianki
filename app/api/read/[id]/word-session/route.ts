import { NextResponse } from "next/server";
import {
  badRequest,
  bodyOf,
  bookCtxOf,
  byLang,
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
 *
 * A word with no card is only a preview here: the decks and word_gloss, no model,
 * no charge. A swipe is what commits it, so its AI meaning comes with `graded`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.email) return badRequest("no email");
  const body = (await bodyOf(req)) as { words?: unknown; graded?: unknown } | null;
  const { book, own, langs } = await bookCtxOf(ctx);
  if (body?.graded !== undefined) {
    const graded = rangeWords(body.graded, own);
    if (!graded) return badRequest("graded words are required");
    let added = 0;
    for (const g of byLang(book, langs, graded)) {
      const gloss = (ws: RangeWord[]) => fillGlosses(ctx.db, g.book, ws, { userId: ctx.userId });
      added += await addGradedEntries(ctx.db, ctx.email, g.book, g.words, gloss);
    }
    return json({ added });
  }
  const words = rangeWords(body?.words, own);
  if (!words) return badRequest("words are required");
  // A meaning for every card lacking one: the decks over the book's lemmas, the
  // generated glosses, the model (lib/read/gloss.ts); a preview without the model.
  // Each word in its own language (a book that mixes languages: reader-route byLang).
  const groups = byLang(book, langs, words);
  if (groups.length === 1) {
    const g = groups[0];
    const gloss = (ws: RangeWord[]) => fillGlosses(ctx.db, g.book, ws, { userId: ctx.userId });
    const preview = (ws: RangeWord[]) => fillGlosses(ctx.db, g.book, ws, null);
    return json(await scopeSession(ctx.db, ctx.email, g.book, g.words, gloss, undefined, preview));
  }
  const parts = [];
  for (const g of groups) {
    const gloss = (ws: RangeWord[]) => fillGlosses(ctx.db, g.book, ws, { userId: ctx.userId });
    const preview = (ws: RangeWord[]) => fillGlosses(ctx.db, g.book, ws, null);
    parts.push(await scopeSession(ctx.db, ctx.email, g.book, g.words, gloss, undefined, preview));
  }
  // In the range's order, as one group gives them.
  const at = new Map(words.map((w, i) => [w.w, i]));
  const lists = parts.flatMap((r) => r.lists);
  return json({
    items: parts.flatMap((r) => r.items).sort((a, b) => (at.get(a.w) ?? 0) - (at.get(b.w) ?? 0)),
    lists: lists.filter((l, i) => lists.findIndex((x) => x.id === l.id) === i),
    missing: parts.flatMap((r) => r.missing),
  });
}
