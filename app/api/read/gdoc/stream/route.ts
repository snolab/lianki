// The live stream from a Google Docs tab (docs/connections.md, "Live stream"):
// the userscript, on a doc the user switched on, posts the page's own HTML
// export whenever the doc changes. The doc's text reaches us with the user's
// Google login in their own tab, so no Drive grant is involved.
//
//   GET  → 200 { on: true } when this user may stream, else 404: the userscript
//          shows its switch only then.
//   POST { docId, html, title? } → the book, stored as a Docs import is; an
//          open reader (/read/<id>?streamingFrom=google-docs) is told through
//          lianki-push, and fetches it.
//   POST { book, ops } → live edits from Google's channel, passed through
//          lianki-push to that user's open readers, and stored nowhere: the
//          next save holds them. Every edit, so no D1 write here.
//
// The body becomes the sender's own book and nobody else's. Gate: a session,
// D1, and flag `read.gdoc-stream` or the owner.
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { flagIn, type FlagValues } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { GDOC_LIMITS } from "@/lib/gdoc/fetch";
import { parseGdocHtml } from "@/lib/gdoc/parse";
import { isOwner } from "@/lib/owner";
import { checkBook } from "@/lib/read/book";
import { storeGdocBook } from "@/lib/read/gdoc-store";
import type { D1Batch } from "@/lib/read/reader-store";
import { routeLimit, readJsonCapped, tooMany } from "@/lib/security/route-guard";
import type { TailOp } from "@/lib/read/gdoc-tail";
import { tellReaders } from "@/lib/read/tell-readers";

const DOC_ID = /^[A-Za-z0-9_-]{25,128}$/;
/** Sends per user per window (D1 counter). The userscript sends after a pause in the edits. */
const RATE = { windowMs: 10 * 60_000, max: 400 };
/** Live edits per user per window, counted per isolate. */
const LIVE_RATE = { windowMs: 60_000, max: 600 };
const LIVE_MAX_OPS = 500;
const BOOK_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isOp = (o: unknown): o is TailOp => {
  const v = o as Record<string, unknown> | null;
  return (
    (Number.isInteger(v?.i) && typeof v?.s === "string") ||
    (Number.isInteger(v?.si) && Number.isInteger(v?.ei))
  );
};

const fail = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });

function streamOn(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return owner || flagIn(flags, "read.gdoc-stream");
}

async function gate() {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return null;
  if (dbBackend() !== "d1") return null;
  return streamOn(await readFlags(), isOwner(session.user.email ?? null)) ? userId : null;
}

export async function GET() {
  return (await gate()) ? NextResponse.json({ on: true }) : fail("Not found", 404);
}

export async function POST(request: NextRequest) {
  const userId = await gate();
  if (!userId) return fail("Not found", 404);
  const body = await readJsonCapped(request, GDOC_LIMITS.maxHtmlChars + 4096);
  if (!body.ok) return fail(body.status === 413 ? "too-large" : "bad-body", body.status);
  const { docId, html, title, book, ops } = (body.value ?? {}) as Record<string, unknown>;

  if (ops !== undefined) {
    if (
      typeof book !== "string" ||
      !BOOK_ID.test(book) ||
      !Array.isArray(ops) ||
      ops.length > LIVE_MAX_OPS ||
      !ops.every(isOp)
    )
      return fail("bad-body", 400);
    const live = await routeLimit(`read-gdoc-live:${userId}`, LIVE_RATE, null);
    if (!live.allowed) return fail("rate-limited", 429);
    tellReaders(userId, { book, ops: ops as TailOp[] });
    return NextResponse.json({ ok: true });
  }

  const limited = await tooMany(`read-gdoc-stream:${userId}`, RATE);
  if (limited) return limited;
  if (typeof docId !== "string" || !DOC_ID.test(docId)) return fail("bad-doc", 400);
  if (typeof html !== "string" || !html) return fail("bad-body", 400);

  const parsed = parseGdocHtml(
    html,
    typeof title === "string" && title.trim() ? title.trim().slice(0, 300) : null,
  );
  const checked = checkBook(parsed);
  if (!checked.ok) {
    return checked.error === "too-much-text" ? fail("too-much-text", 413) : fail("no-text", 422);
  }
  const stored = await storeGdocBook(getD1() as unknown as D1Batch, userId, docId, checked.book);
  if (stored.changed) tellReaders(userId, { book: stored.id, hash: stored.hash });
  return NextResponse.json({ id: stored.id, changed: stored.changed, hash: stored.hash });
}
