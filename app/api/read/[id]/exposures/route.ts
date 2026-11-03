import { NextResponse } from "next/server";
import { badRequest, bodyOf, json, readerCtx } from "@/lib/read/reader-route";
import { exposureRow, recordExposures, type ExposureRow } from "@/lib/read/reader-store";
import { parseSentenceId, type ExposureBatch, type ExposureResponse } from "@/lib/read/reader-api";
import { sentenceIndex } from "@/lib/read/units";
import { normWord, wordsOf } from "@/lib/read/words";

/** Events one request may carry (a resend of a long session is split by the client). */
const MAX_EVENTS = 1_000;

/**
 * POST /api/read/[id]/exposures — words seen in context. An exposure log
 * only: word cards are never changed (docs/books-plan.md, option A).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const body = (await bodyOf(req)) as Partial<ExposureBatch> | null;
  if (!body || !Array.isArray(body.events)) return badRequest("events are required");
  if (body.events.length > MAX_EVENTS) return badRequest("too many events");
  const { book } = await ctx.load();
  const b = book.sentences;
  const now = new Date();
  const rows: ExposureRow[] = [];
  const at = new Map<string, number>();
  let rejected = 0;
  for (const e of body.events) {
    const r = exposureRow(e, now, (w) => normWord(w, book.lang));
    const p = r && parseSentenceId(r.sid);
    const i = p && p.bookHash === book.hash ? sentenceIndex(b, p.line, p.index) : -1;
    if (!r || i < 0) {
      rejected++;
      continue;
    }
    at.set(r.sid, i);
    rows.push(r);
  }
  const sentenceWords = (sid: string) => {
    const i = at.get(sid)!;
    const l = b.refs[i * 4];
    return wordsOf(book.lines[l].slice(b.refs[i * 4 + 2], b.refs[i * 4 + 3]), book.lang);
  };
  const r = await recordExposures(ctx.db, ctx.ref, rows, sentenceWords);
  return json<ExposureResponse>({ ...r, rejected });
}
