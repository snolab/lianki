import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { getReadMaterialById, deleteReadMaterial } from "@/lib/getReadMaterialsCollection";
import { dbBackend, getD1 } from "@/lib/d1";
import { materialWords, summarizeMaterials } from "@/lib/read/progress";

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

  return NextResponse.json({
    id: material._id.toString(),
    title: material.title,
    content: book ? undefined : text,
    book: book ?? undefined,
    words,
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
  const deleted = await deleteReadMaterial(session.user.id, id);

  if (!deleted) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
