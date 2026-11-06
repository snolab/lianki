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
  wordCtx,
} from "@/lib/read/reader-route";
import { gradeBatch, probeBatch, undoBatch, type BatchCtx } from "@/lib/read/batch-grade-server";
import { fillGlosses } from "@/lib/read/gloss-server";
import type { BookCtx, RangeWord } from "@/lib/read/book-word-list";

/**
 * POST /api/read/[id]/batch-grade — the selection card's grade handle
 * (lib/read/batch-grade.ts; docs/books-plan.md, "Grading from the selection card"):
 *
 *   { probe: { sentences: [sid], words: [RangeWord] } } → { sentences, words, sentenceNext }
 *   { clientId, rating, sentences: [sid], words: [RangeWord], day? }   → BatchResult
 *   { undo: clientId, day? }                                           → { restored, changed }
 *
 * One validated call per batch: only the selection's due or never-graded
 * sentences and its due or new words are graded (words without a card get
 * one in the list of their own language first, as make-cards files them; a
 * word's AI meaning, and its cost, come only here). `undo` takes a batch — or a paragraph
 * swipe's grade already sent — back to exactly the states before it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.email) return badRequest("no email");
  const body = (await bodyOf(req)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return badRequest("body must be an object");
  const { book: bctx, own, langs } = await bookCtxOf(ctx);
  const day = typeof body.day === "string" ? body.day : undefined;
  if (body.undo !== undefined) {
    const r = await undoBatch(
      { db: ctx.db, ref: ctx.ref, email: ctx.email, bctx },
      body.undo,
      day,
      langs.map((l) => bookInLang(bctx, l).hash),
    );
    return r ? json(r) : NextResponse.json({ error: "Nothing to undo" }, { status: 409 });
  }
  const { book, w } = await wordCtx(ctx);
  const c: BatchCtx = {
    db: ctx.db,
    ref: ctx.ref,
    email: ctx.email,
    book,
    w,
    bctx,
    byLang: (ws) => byLang(bctx, langs, ws),
  };
  if (body.probe !== undefined) {
    const p = (body.probe ?? {}) as { sentences?: unknown; words?: unknown };
    const words = p.words === undefined ? [] : rangeWords(p.words, own);
    if (!words) return badRequest("words are invalid");
    const r = await probeBatch(c, p.sentences, words, new Date());
    return r.ok ? json(r.res) : badRequest(r.error);
  }
  const words = body.words === undefined ? [] : rangeWords(body.words, own);
  if (!words) return badRequest("words are invalid");
  const glossFor = (b: BookCtx) => (ws: RangeWord[]) =>
    fillGlosses(ctx.db, b, ws, { userId: ctx.userId });
  const r = await gradeBatch(c, { ...body, day }, words, new Date(), glossFor);
  return r.ok ? json(r.res) : badRequest(r.error);
}
