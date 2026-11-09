import { offSiteHeaders } from "@/lib/security/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import {
  getReadMaterialById,
  deleteReadMaterial,
  renameReadMaterial,
  replaceReadMaterialContent,
} from "@/lib/getReadMaterialsCollection";
import { cleanTitle } from "@/lib/read/title";
import { sameOriginJson } from "@/lib/security/same-origin";
import { detectBook } from "@/lib/read/prep";
import { dbBackend, getD1 } from "@/lib/d1";
import { materialWords, summarizeMaterials } from "@/lib/read/progress";
import { hashOf } from "@/lib/read/reader-book";
import { deleteReaderRows, saveContentHash, type D1Batch } from "@/lib/read/reader-store";
import type { ReaderV2Fields } from "@/lib/read/reader-api";

// GET /api/read/[id] - Get material by ID
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const material = await getReadMaterialById(session.user.id, id);

  if (!material) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  // The two backfills below are saved for next time, so another site's link
  // gets the same answer without saving them.
  const saving = !offSiteHeaders(await headers());
  const mw = await materialWords(material, session.user.id);
  const { text, stats } = mw;
  let fullBook = mw.book;
  // The import pipeline's detector (lib/read/prep.ts), for a book imported
  // before it: run once on open and stored, so the reader's polish offer is
  // not worked out again on every open. Only the shape is added; the text
  // stays as it is until he re-imports or polishes it.
  if (fullBook && !fullBook.shape && dbBackend() === "d1") {
    const shape = detectBook({
      lines: material.lines,
      headings: fullBook.headings ?? [],
      continues: fullBook.continues,
    });
    fullBook = { ...fullBook, shape };
    if (saving) {
      try {
        await replaceReadMaterialContent(session.user.id, id, JSON.stringify(fullBook));
      } catch (err) {
        console.error("read: shape backfill failed", err);
      }
    }
  }
  // The word list itself is /api/read/[id]/words; the header needs the counts.
  const book = fullBook ? { ...fullBook, words: undefined } : null;
  const [words] = await summarizeMaterials(dbBackend() === "d1" ? getD1() : null, session.user, [
    { material, stats },
  ]);

  // The reader's server features (docs/books-plan.md, "Review units") need D1:
  // `readerV2` says so (kept for custom frontends), with the book hash its
  // sentence ids use, backfilled into the row on this open.
  const v2: ReaderV2Fields = { readerV2: false };
  if (dbBackend() === "d1") {
    v2.readerV2 = true;
    v2.bookHash = await hashOf(material);
    if (!material.contentHash && saving) {
      try {
        await saveContentHash(getD1(), session.user.id, id, v2.bookHash);
      } catch (err) {
        console.error("read: content hash backfill failed", err);
      }
    }
  }

  return NextResponse.json({
    id: material._id.toString(),
    title: material.title,
    content: book ? undefined : text,
    book: book ?? undefined,
    words,
    ...v2,
    lines: material.lines,
    createdAt: material.createdAt.toISOString(),
    updatedAt: material.updatedAt.toISOString(),
  });
}

// PATCH /api/read/[id] {title} - Rename the user's own material (the /read
// row menu). Same-origin JSON only; the title is cleaned and capped
// (lib/read/title.ts) and marked as the user's, so a re-import of the
// source keeps it.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!sameOriginJson(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
  const title = cleanTitle(body?.title);
  if (!title) return NextResponse.json({ error: "bad-title" }, { status: 400 });
  const { id } = await params;
  if (!(await renameReadMaterial(session.user.id, id, title))) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }
  return NextResponse.json({ id, title });
}

// DELETE /api/read/[id] - Delete material
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const material = dbBackend() === "d1" ? await getReadMaterialById(session.user.id, id) : null;
  const deleted = await deleteReadMaterial(session.user.id, id);

  if (!deleted) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }
  // Its reader-v2 rows go with it (unless the user keeps another copy of the text).
  if (material) {
    try {
      await deleteReaderRows(
        getD1() as unknown as D1Batch,
        session.user.id,
        id,
        await hashOf(material),
      );
    } catch (err) {
      console.error("read: deleting reader rows failed", err);
    }
  }

  return NextResponse.json({ success: true });
}
