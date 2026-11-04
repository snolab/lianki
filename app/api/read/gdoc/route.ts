// POST /api/read/gdoc { url } — import a Google Doc into /read as a book.
//
// Only docs shared "anyone with the link" (the public HTML export); private
// docs need a Google connection, which comes later. The URL is reduced to a
// document id (lib/gdoc/url.ts) and only Google's export URL for that id is
// fetched. The book is the importer's own, never shared. Importing the same
// doc again updates that book in place: same id, and the FSRS state of every
// unchanged line carried over to the new text's sentence ids.
//
// Gate: as every reader-v2 route (lib/read/reader-route.ts): a session, D1,
// and the `read.reader-v2` flag or the owner. Rate-limited per user.

import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { hit } from "@/lib/security/throttle";
import {
  findReadMaterialBySource,
  replaceReadMaterialText,
  saveReadMaterial,
} from "@/lib/getReadMaterialsCollection";
import { fetchGdocHtml, GdocError } from "@/lib/gdoc/fetch";
import { parseGdocHtml } from "@/lib/gdoc/parse";
import { gdocIdOf, gdocSourceKey, gdocUrlOf } from "@/lib/gdoc/url";
import { bookMetaOf, checkBook } from "@/lib/read/book";
import { hashOf, readerV2On } from "@/lib/read/reader-book";
import { carrySentenceCards, unchangedLines, type D1Batch } from "@/lib/read/reader-store";
import { bookHash } from "@/lib/read/units";

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

const STATUS: Record<GdocError["code"], number> = {
  "not-shared": 422,
  "not-found": 422,
  "no-text": 422,
  "too-large": 413,
  "too-much-text": 413,
  "fetch-failed": 502,
};

/** Imports per user per window (D1 counter): each one downloads a whole document. */
const RATE = { windowMs: 10 * 60_000, max: 20 };

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return fail("Unauthorized", 401);
  if (dbBackend() !== "d1") return fail("Not found", 404);
  if (!readerV2On(await readFlags(), isOwner(session.user.email ?? null)))
    return fail("Not found", 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("bad-url", 400);
  }
  const id = gdocIdOf((body as { url?: unknown } | null)?.url);
  if (!id) return fail("bad-url", 400);

  const rate = await hit(getD1(), `read-gdoc:${userId}`, RATE);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  let parsed;
  try {
    const { html, title } = await fetchGdocHtml(id);
    parsed = parseGdocHtml(html, title);
  } catch (err) {
    if (err instanceof GdocError) return fail(err.code, STATUS[err.code]);
    console.error("read: gdoc import failed", err);
    return fail("fetch-failed", 502);
  }
  const checked = checkBook(parsed);
  if (!checked.ok) {
    return fail(
      checked.error === "too-much-text" ? "too-much-text" : "no-text",
      checked.error === "too-much-text" ? 413 : 422,
    );
  }
  const b = checked.book;
  const meta = bookMetaOf(b, { source: "gdoc", sourceUrl: gdocUrlOf(id) });
  const content = JSON.stringify(meta);
  const hash = await bookHash(b.lines);
  const key = gdocSourceKey(id);

  const prev = await findReadMaterialBySource(userId, key);
  if (prev) {
    const pid = String(prev._id);
    const prevHash = await hashOf(prev);
    if (prevHash !== hash) {
      await carrySentenceCards(
        getD1() as unknown as D1Batch,
        userId,
        prevHash,
        hash,
        unchangedLines(prev.lines, b.lines),
      );
    }
    await replaceReadMaterialText(userId, pid, b.title, b.lines, content, hash);
    return NextResponse.json({
      id: pid,
      title: b.title,
      lineCount: b.lines.length,
      updated: true,
      changed: prevHash !== hash,
    });
  }

  const material = await saveReadMaterial(userId, b.title, content, b.lines, hash, key);
  return NextResponse.json({
    id: String(material._id),
    title: material.title,
    lineCount: material.lines.length,
    updated: false,
    changed: true,
  });
}
