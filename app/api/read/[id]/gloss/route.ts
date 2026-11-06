import { NextResponse } from "next/server";
import {
  badRequest,
  bodyOf,
  bookCtxOf,
  json,
  rangeWords,
  readerCtx,
} from "@/lib/read/reader-route";
import { fillGlosses } from "@/lib/read/gloss-server";
import { glossMayAskModel, headOf } from "@/lib/read/gloss";
import { draftOwn } from "@/lib/read/live-polish-server";

/**
 * POST /api/read/[id]/gloss — the meaning of a selected book word that is no
 * card of his (owner, 2026-11-05 02:11 JST: the card's 查词 button went; a
 * tap shows the meaning by itself). The same path as 制卡's meanings
 * (lib/read/gloss-server.ts fillGlosses): the decks over the book's lemmas,
 * the shared word_gloss rows, else the model — its real cost through chargeAi.
 * `ex` never reaches a shared row: the model's example is the stored book's line.
 *
 *   { w, ex? }  → { term, back }   (back null: none found, or a name of the book)
 *
 * With `cached: true`, and always on a /vibe doc (private speech, docs/vibe.md):
 * the decks and word_gloss only — no model, no charge. A meaning the model must
 * make is then made when the word is committed (batch-grade), not before.
 *
 * With `own: true` (the user's own AI is on, docs/byok.md): the decks and
 * word_gloss only — no model, no charge — and, when they have nothing,
 * `ask: { lang, term }`: the headword the browser asks the user's own
 * provider for. That answer stays on the device; nothing is written here.
 *
 * With `draft: true`: a word of a live doc's speech draft, which may be in no
 * save of the book (live-polish-server.ts draftOwn). 429 over its limit.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.email) return badRequest("no email");
  const body = (await bodyOf(req)) as {
    w?: unknown;
    ex?: unknown;
    own?: unknown;
    cached?: unknown;
    draft?: unknown;
  } | null;
  const { book, own } = await bookCtxOf(ctx);
  const taken = body?.draft === true ? await draftOwn(own, ctx) : own;
  if (!taken) return json({ error: "busy" }, 429);
  const words = rangeWords([{ w: body?.w, ex: body?.ex }], taken);
  if (!words?.length) return badRequest("a word of the book is required");
  const byok = body?.own === true;
  const source = (await ctx.load()).words.book?.source;
  const ai = glossMayAskModel(body ?? {}, source) ? { userId: ctx.userId } : null;
  const [x] = await fillGlosses(ctx.db, book, words, ai);
  const back = x.back ?? null;
  if (!byok) return json({ term: x.term ?? x.w, back });
  const open = !back && source !== "vibe" && book.lang !== "und" && !book.names?.has(x.w);
  return json({
    term: x.term ?? x.w,
    back,
    ask: open ? { lang: book.lang, term: headOf(x.w, book.lem) } : null,
  });
}
