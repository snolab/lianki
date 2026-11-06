import { NextResponse } from "next/server";
import { getReadMaterialContent, replaceReadMaterialText } from "@/lib/getReadMaterialsCollection";
import { bookMetaOf, parseBookMeta, type ParsedBook } from "@/lib/read/book";
import { applyPolish, polishChunks } from "@/lib/read/polish";
import { polishRefused } from "@/lib/read/polish-offer";
import { polishChunksAi } from "@/lib/read/polish-server";
import { prepareBook } from "@/lib/read/prep-server";
import { readerBook } from "@/lib/read/reader-book";
import { badRequest, json, readerCtx } from "@/lib/read/reader-route";
import { carrySentenceCardsByText, keepRawText, readRawText } from "@/lib/read/reader-store";
import { sentenceCarryMap } from "@/lib/read/sentence-cards";
import { bookHash } from "@/lib/read/units";

/**
 * /api/read/[id]/polish — the AI polish of a raw transcript (lib/read/polish.ts;
 * docs/books-plan.md, "Import pipeline"). Only on his tap: the reader offers
 * it when the detector stored `shape.raw` on the book.
 *
 *   GET  → { raw: string[] | null, polished }   the raw text kept beside a polish
 *   POST → { chunks, kept, lineCount }           polish from the raw text, keep the raw
 *
 * Always from the raw text (a second polish redoes it, never polishes a
 * polish). The raw text is stored the first time and never overwritten.
 * Sentence cards follow their words to the new ids. 400 not a book ·
 * 413 too long · 429 over the per-user limit · 502 the model failed ·
 * 503 Workers AI not configured. Logs never carry the text.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const raw = await readRawText(ctx.db, ctx.userId, ctx.ref.materialId);
  const { words } = await ctx.load();
  return json({ raw: raw?.lines ?? null, polished: words.book?.polished ?? null });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await readerCtx((await params).id);
  if (ctx instanceof NextResponse) return ctx;
  const { book: current, words } = await ctx.load();
  const meta = words.book;
  if (!meta) return badRequest("not a book");
  if (polishRefused(meta)) return badRequest("not offered");
  const mid = ctx.ref.materialId;

  const kept = await readRawText(ctx.db, ctx.userId, mid);
  const raw = kept ?? {
    lines: ctx.material.lines,
    content: await getReadMaterialContent(ctx.material),
  };
  const rawMeta = parseBookMeta(raw.content) ?? meta;
  const parsed: ParsedBook = {
    title: ctx.material.title,
    ...(rawMeta.lang ? { lang: rawMeta.lang } : {}),
    lines: raw.lines,
    chapters: rawMeta.chapters,
    headings: rawMeta.headings ?? [],
    ...(rawMeta.markup
      ? {
          marks: rawMeta.marks ?? [],
          breaks: rawMeta.breaks ?? [],
          continues: rawMeta.continues ?? [],
        }
      : {}),
  };
  const chunks = polishChunks(raw.lines, new Set(parsed.headings));
  const run = await polishChunksAi(chunks, { userId: ctx.userId });
  if (!run.ok) {
    const status = { busy: 429, "too-long": 413, "model-failed": 502, "not-configured": 503 }[
      run.error
    ];
    return json({ error: run.error }, status);
  }

  const { book: b, shape } = await prepareBook(applyPolish(parsed, chunks, run.polished), {
    db: ctx.db,
    userId: ctx.userId,
    splitBreaks: true,
  });
  const keptChunks = run.polished.filter(Boolean).length;
  const next = bookMetaOf(b, {
    source: meta.source,
    ...(meta.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
    ...(meta.credit ? { credit: meta.credit } : {}),
    // The offer was about the raw text: its shape stays.
    shape: rawMeta.shape ?? meta.shape ?? shape,
    polished: { at: new Date().toISOString(), chunks: chunks.length, kept: keptChunks },
  });
  const content = JSON.stringify(next);
  const hash = await bookHash(b.lines);

  // The raw text first: if anything after fails, it is safe.
  if (!kept) await keepRawText(ctx.db, ctx.userId, mid, raw);
  const after = readerBook(b.lines, next, hash);
  await carrySentenceCardsByText(
    ctx.db,
    ctx.userId,
    current.hash,
    hash,
    sentenceCarryMap(current.sentences, current.lines, after.sentences, after.lines),
  );
  await replaceReadMaterialText(ctx.userId, mid, ctx.material.title, b.lines, content, hash);
  return json({ chunks: chunks.length, kept: keptChunks, lineCount: b.lines.length });
}
