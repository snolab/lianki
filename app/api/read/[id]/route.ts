import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { getReadMaterialById, deleteReadMaterial } from "@/lib/getReadMaterialsCollection";
import { dbBackend, getD1 } from "@/lib/d1";
import { materialWords, summarizeMaterials } from "@/lib/read/progress";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { hashOf, readerV2On } from "@/lib/read/reader-book";
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

  const { book: fullBook, text, stats } = await materialWords(material, session.user.id);
  // The word list itself is /api/read/[id]/words; the header needs the counts.
  const book = fullBook ? { ...fullBook, words: undefined } : null;
  const [words] = await summarizeMaterials(dbBackend() === "d1" ? getD1() : null, session.user, [
    { material, stats },
  ]);

  // Reader v2 (docs/books-plan.md, "Review units"): on for this user? And the
  // book hash its sentence ids use, backfilled into the row on this open.
  const v2: ReaderV2Fields = { readerV2: false };
  if (dbBackend() === "d1") {
    v2.readerV2 = readerV2On(await readFlags(), isOwner(session.user.email));
    v2.bookHash = await hashOf(material);
    if (!material.contentHash) {
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
