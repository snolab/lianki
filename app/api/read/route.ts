import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import {
  findReadMaterialByText,
  getReadMaterialById,
  getReadMaterialContent,
  listReadMaterials,
  replaceReadMaterialContent,
  saveReadMaterial,
} from "@/lib/getReadMaterialsCollection";
import { parseBookMeta } from "@/lib/read/book";
import { recentProgress, saveContentHash } from "@/lib/read/reader-store";
import { bookHash } from "@/lib/read/units";
import { isoDay } from "@/lib/dates";
import { BOOK_LIMITS, bookMetaOf, checkBook } from "@/lib/read/book";
import { cappedJsonError, readJsonCapped } from "@/lib/security/route-guard";
import { dbBackend, getD1 } from "@/lib/d1";
import { materialWords, summarizeMaterials, withLex } from "@/lib/read/progress";
import { countWords } from "@/lib/read/words";

/** The longest POST body read: a whole book with its markup. */
const READ_BODY_MAX = 12 * 1024 * 1024;

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
    materials: materials.map((m, i) => listRow(m, words[i])),
    // The first batch carries "Continue reading": the book read last, and where.
    ...(page === 1 ? { last: await lastRead(session.user) } : {}),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

type ListedMaterial = Awaited<ReturnType<typeof listReadMaterials>>["materials"][number];
type Summary = Awaited<ReturnType<typeof summarizeMaterials>>[number];

/** One row of the /reader list. */
function listRow(m: ListedMaterial, words: Summary) {
  return {
    id: m._id.toString(),
    title: m.title,
    // The list shows a count only; a whole book's lines stay out of it.
    lines: [],
    lineCount: m.lines.length,
    words,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

/** How many recent positions are tried for "Continue reading" (a deleted book is skipped). */
const LAST_READ_TRIES = 5;

/** The book whose reading position moved last, as a list row plus its line; null when none. */
async function lastRead(user: { id: string; email?: string | null }) {
  const db = d1OrNull();
  if (!db) return null;
  try {
    for (const p of await recentProgress(db, user.id, LAST_READ_TRIES)) {
      const m = await getReadMaterialById(user.id, p.materialId);
      if (!m) continue;
      const [words] = await summarizeMaterials(db, user, [
        { material: m, stats: (await materialWords(m, user.id)).stats },
      ]);
      return { ...listRow(m, words), line: p.line, readAt: p.at };
    }
  } catch (err) {
    console.error("read: last read", err);
  }
  return null;
}

// POST /api/read - Create new material
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // A book's text is capped by checkBook (1.5 MB of text); its JSON with the
  // chapter and markup arrays stays well inside this. Nothing larger is read.
  const read = await readJsonCapped(request, READ_BODY_MAX);
  if (!read.ok) return cappedJsonError(read.status);
  const body: unknown = read.value;

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
    const hash = dbBackend() === "d1" ? await bookHash(b.lines) : undefined;
    // The same text imported again with its markup (books from before #448's
    // markup had none): upgrade that book in place, same id and history.
    const prev =
      hash && bookMeta.markup ? await findReadMaterialByText(session.user.id, hash, b.lines) : null;
    const prevMeta = prev ? parseBookMeta(await getReadMaterialContent(prev)) : null;
    if (prev && prevMeta && !prevMeta.markup) {
      const pid = String(prev._id);
      await replaceReadMaterialContent(session.user.id, pid, JSON.stringify(bookMeta));
      if (!prev.contentHash) await saveContentHash(getD1(), session.user.id, pid, hash!);
      const [words] = await summarizeMaterials(d1OrNull(), session.user, [
        { material: prev, stats: bookMeta.words! },
      ]);
      return NextResponse.json({
        id: pid,
        title: prev.title,
        lineCount: prev.lines.length,
        words,
        upgraded: true,
        createdAt: prev.createdAt.toISOString(),
        updatedAt: prev.updatedAt.toISOString(),
      });
    }
    const material = await saveReadMaterial(
      session.user.id,
      b.title,
      JSON.stringify(bookMeta),
      b.lines,
      hash,
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
  // Pasted text: the same caps as a book.
  if (
    new TextEncoder().encode(content).byteLength > BOOK_LIMITS.maxTextBytes ||
    (typeof title === "string" && title.length > BOOK_LIMITS.maxTitleChars)
  ) {
    return NextResponse.json({ error: "too-much-text" }, { status: 413 });
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
