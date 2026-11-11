import { NextResponse } from "next/server";
import {
  badRequest,
  bodyOf,
  bookCtxOf,
  bookInLang,
  byLang,
  json,
  rangeWords,
  readerCtx,
  payerOf,
} from "@/lib/read/reader-route";
import { makeCards, unmakeCards, type RangeWord } from "@/lib/read/book-word-list";
import { fillGlosses } from "@/lib/read/gloss-server";
import { draftOwn } from "@/lib/read/live-polish-server";

/**
 * POST /api/read/[id]/make-cards — 制卡: a card in the book's own list (of
 * the word's own language, in a book that mixes languages) for
 * every word of the range that has no card in any of his lists (never a
 * second card), or the undo of that:
 *
 *   { words: [{ w, ex, term?, reading?, back? }] }  → { listId, terms }
 *   { undo: [term, …] }                            → { removed }  (only cards still unreviewed)
 *
 * With `draft: true`: words of a live doc's speech draft, which may be in no save
 * of the book (live-polish-server.ts draftOwn). 429 over its limit.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.email) return badRequest("no email");
  const body = (await bodyOf(req)) as { words?: unknown; undo?: unknown; draft?: unknown } | null;
  if (body?.undo !== undefined) {
    if (!Array.isArray(body.undo) || body.undo.length > 400)
      return badRequest("terms are required");
    const terms = body.undo.filter((t): t is string => typeof t === "string" && t.length <= 200);
    // Each of the book's languages has its own list (reader-route byLang).
    const { book, langs } = await bookCtxOf(ctx);
    let removed = 0;
    for (const l of langs)
      removed += await unmakeCards(ctx.db, ctx.email, bookInLang(book, l).hash, terms);
    return json({ removed });
  }
  const { book, own, langs } = await bookCtxOf(ctx);
  const taken = body?.draft === true ? await draftOwn(own, ctx) : own;
  if (!taken) return json({ error: "busy" }, 429);
  const words = rangeWords(body?.words, taken);
  if (!words) return badRequest("words are required");
  // Each word in its own language's list (a book that mixes languages).
  let listId: string | null = null;
  const terms: string[] = [];
  for (const g of byLang(book, langs, words)) {
    const gloss = (ws: RangeWord[]) => fillGlosses(ctx.db, g.book, ws, payerOf(ctx));
    const r = await makeCards(ctx.db, ctx.email, g.book, g.words, undefined, gloss);
    listId ??= r.listId;
    terms.push(...r.terms);
  }
  return json({ listId, terms });
}
