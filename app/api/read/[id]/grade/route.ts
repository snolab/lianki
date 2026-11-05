import { NextResponse } from "next/server";
import {
  badRequest,
  bodyOf,
  bookCtxOf,
  json,
  rangeWords,
  readerCtx,
  wordCtx,
} from "@/lib/read/reader-route";
import { gradeFor } from "@/lib/read/reader-service";
import { gradeEasyWords, type RangeWord } from "@/lib/read/book-word-list";
import { fillGlosses } from "@/lib/read/gloss-server";
import { dayKey } from "@/lib/words/schedule";
import type { GradeRequest } from "@/lib/read/reader-api";

/** How long the words' meanings may hold up an Easy grade's request. */
const GLOSS_WAIT_MS = 5000;

/**
 * POST /api/read/[id]/grade — one swipe: FSRS on each of the item's sentences.
 * An Easy grade with `easyWords` also grades the item's due and new words
 * Easy (lib/read/book-word-list.ts gradeEasyWords: his own cards only, each
 * due checked here). A failure there answers 500 so the device sends the
 * whole grade again: the paragraph's part is idempotent by clientId, the
 * words' by their due.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const body = (await bodyOf(req)) as Partial<GradeRequest> | null;
  const { book, w } = await wordCtx(ctx);
  const now = new Date();
  const r = await gradeFor(ctx.db, ctx.ref, book, w, body, now);
  if (!r.ok) return badRequest(r.error);
  const ew = body?.easyWords;
  if (body?.rating !== 4 || !ew || typeof ew !== "object" || !ctx.email) return json(r.res);
  const b = await bookCtxOf(ctx);
  const words = rangeWords(ew.words, b.own);
  if (!words?.length) return json({ ...r.res, words: { graded: 0, made: 0 } });
  try {
    // Meanings for the new cards as 制卡 finds them, but never holding the
    // grade up: past GLOSS_WAIT_MS the cards are made without (the word
    // review fills a missing meaning later, book-word-list.ts backfill).
    const gloss = (ws: RangeWord[]) =>
      Promise.race([
        fillGlosses(ctx.db, b.book, ws, { userId: ctx.userId }).catch(() => ws),
        new Promise<RangeWord[]>((ok) => setTimeout(() => ok(ws), GLOSS_WAIT_MS)),
      ]);
    const out = await gradeEasyWords(
      ctx.db,
      ctx.email,
      b.book,
      words,
      dayKey(ew.day, now),
      now,
      gloss,
    );
    return json({ ...r.res, words: out });
  } catch (err) {
    console.error("read: easy words failed", err);
    return json({ error: "words not graded" }, 500);
  }
}
