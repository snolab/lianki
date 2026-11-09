import { NextResponse } from "next/server";
import {
  badRequest,
  bodyOf,
  bookCtxOf,
  json,
  rangeWords,
  readerCtx,
  wordCtx,
  payerOf,
} from "@/lib/read/reader-route";
import { dwellOf, gradeFor } from "@/lib/read/reader-service";
import { qualifies, recordStudySafe } from "@/lib/study-days";
import { gradeWords } from "@/lib/read/batch-grade-server";
import { undoRecord, undoWordsStatement } from "@/lib/read/reader-store";
import type { RangeWord } from "@/lib/read/book-word-list";
import { fillGlosses } from "@/lib/read/gloss-server";
import type { GradeRequest } from "@/lib/read/reader-api";

/** How long the new cards' meanings may hold up an Easy grade's request. */
const GLOSS_WAIT_MS = 5000;

/**
 * POST /api/read/[id]/grade — one swipe: FSRS on each of the item's sentences.
 *
 * An Easy grade with `easyWords` also grades the item's due and new words
 * Easy (owner, 2026-11-05 02:31 JST) through the selection card's batch path
 * (lib/read/batch-grade-server.ts gradeWords: his own cards only, each due
 * checked here, words with no card carded in the book's list first), and
 * keeps them in the grade's undo record (read_grade_undo), so taking the
 * grade back once sent (batch-grade `{ undo }`) restores the words exactly
 * too. A failure there answers 500 and the device sends the whole grade
 * again: the paragraph part is idempotent by clientId, the words by their
 * record (or, before it, their due).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const body = (await bodyOf(req)) as Partial<GradeRequest> | null;
  const { book, w } = await wordCtx(ctx);
  const now = new Date();
  const r = await gradeFor(ctx.db, ctx.ref, book, w, body, now);
  if (!r.ok) return badRequest(r.error);
  // Study days (docs/levels.md): one swipe read for at least reaction time,
  // by the server's clock; a resent grade (duplicate) is not a new read.
  if (!r.res.duplicate && qualifies(dwellOf(body, now)))
    await recordStudySafe(ctx.db, ctx.email, 1, now);
  const ew = body?.easyWords;
  if (body?.rating !== 4 || !ew || typeof ew !== "object" || !ctx.email) return json(r.res);
  const id = r.res.reviewId;
  // Sent again after its words landed: nothing more to do.
  if (r.res.duplicate && (await undoRecord(ctx.db, ctx.ref.userId, id))?.words)
    return json({ ...r.res, words: { graded: 0, made: 0 } });
  const { book: bctx, own } = await bookCtxOf(ctx);
  const words = rangeWords(ew.words, own);
  if (!words?.length) return json({ ...r.res, words: { graded: 0, made: 0 } });
  try {
    // Meanings for the new cards as 制卡 finds them, never holding the grade
    // up for long: past GLOSS_WAIT_MS the cards are made without (the word
    // review fills a missing meaning later).
    const gloss = (ws: RangeWord[]) =>
      Promise.race([
        fillGlosses(ctx.db, bctx, ws, payerOf(ctx)).catch(() => ws),
        new Promise<RangeWord[]>((ok) => setTimeout(() => ok(ws), GLOSS_WAIT_MS)),
      ]);
    const c = { db: ctx.db, email: ctx.email, bctx };
    const g = await gradeWords(c, words, 4, ew.day, now, gloss);
    await ctx.db.batch([
      undoWordsStatement(ctx.db, ctx.ref, id, JSON.stringify(g.undoWords), now.toISOString()),
    ]);
    return json({
      ...r.res,
      words: { graded: g.outWords.length, made: g.outWords.filter((x) => x.made).length },
    });
  } catch (err) {
    console.error("read: easy words failed", err);
    return json({ error: "words not graded" }, 500);
  }
}
