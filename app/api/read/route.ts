import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { saveReadMaterial, listReadMaterials } from "@/lib/getReadMaterialsCollection";
import { isoDay } from "@/lib/dates";
import { bookMetaOf, checkBook } from "@/lib/read/book";
import { dbBackend, getD1 } from "@/lib/d1";
import { materialWords, summarizeMaterials, withLex } from "@/lib/read/progress";
import { countWords } from "@/lib/read/words";

const d1OrNull = () => (dbBackend() === "d1" ? getD1() : null);

// GET /api/read - List materials
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  const DEFAULT_PAGE = 1;
  const DEFAULT_PAGE_SIZE = 10;
  const MAX_PAGE_SIZE = 100;

  const rawPage = searchParams.get("page");
  let page = parseInt(rawPage ?? "", 10);
  if (!Number.isFinite(page) || page < 1) {
    page = DEFAULT_PAGE;
  }

  const rawPageSize = searchParams.get("pageSize");
  let pageSize = parseInt(rawPageSize ?? "", 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) {
    pageSize = DEFAULT_PAGE_SIZE;
  } else if (pageSize > MAX_PAGE_SIZE) {
    pageSize = MAX_PAGE_SIZE;
  }

  const { materials, total } = await listReadMaterials(session.user.id, page, pageSize);
  const userId = session.user.id;
  const items = await Promise.all(
    materials.map(async (m) => ({ material: m, stats: (await materialWords(m, userId)).stats })),
  );
  // One card query for the whole page (lib/read/progress.ts).
  const words = await summarizeMaterials(d1OrNull(), session.user, items);

  return NextResponse.json({
    materials: materials.map((m, i) => ({
      id: m._id.toString(),
      title: m.title,
      // The list shows a count only; a whole book's lines stay out of it.
      lines: [],
      lineCount: m.lines.length,
      words: words[i],
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

// POST /api/read - Create new material
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body === null || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }

  const { title, content, book } = body as { title?: unknown; content?: unknown; book?: unknown };

  // A book (EPUB parsed in the browser): validated and capped here, stored as
  // lines + chapter meta (lib/read/book.ts). Always the signed-in user's own.
  if (typeof book !== "undefined") {
    const checked = checkBook(book);
    if (!checked.ok) {
      const status = checked.error === "too-much-text" ? 413 : 400;
      return NextResponse.json({ error: checked.error }, { status });
    }
    const b = checked.book;
    const bookMeta = bookMetaOf(b);
    const material = await saveReadMaterial(
      session.user.id,
      b.title,
      JSON.stringify(bookMeta),
      b.lines,
    );
    const [words] = await summarizeMaterials(d1OrNull(), session.user, [
      { material, stats: bookMeta.words! },
    ]);
    return NextResponse.json({
      id: material._id.toString(),
      title: material.title,
      lineCount: material.lines.length,
      words,
      createdAt: material.createdAt.toISOString(),
      updatedAt: material.updatedAt.toISOString(),
    });
  }

  if (typeof content !== "string" || content.length === 0) {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  if (typeof title !== "undefined" && typeof title !== "string") {
    return NextResponse.json({ error: "Title must be a string" }, { status: 400 });
  }

  const lines = content
    .split(/\n/)
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);

  const materialTitle =
    typeof title === "string" && title.length > 0 ? title : `Import ${isoDay()}`;

  const material = await saveReadMaterial(session.user.id, materialTitle, content, lines);
  const [words] = await summarizeMaterials(d1OrNull(), session.user, [
    { material, stats: await withLex(countWords(lines)) },
  ]);

  return NextResponse.json({
    id: material._id.toString(),
    title: material.title,
    lines: material.lines,
    words,
    createdAt: material.createdAt.toISOString(),
    updatedAt: material.updatedAt.toISOString(),
  });
}
