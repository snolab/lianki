// The live stream from a Google Docs tab (docs/connections.md, "Live stream"):
// the userscript, on a doc the user switched on, posts the page's own HTML
// export whenever the doc changes. The doc's text reaches us with the user's
// Google login in their own tab, so no Drive grant is involved.
//
//   GET  → 200 { on: true } when this user may stream, else 404: the userscript
//          shows its switch only then.
//   POST { docId, html, title? } → the book, stored as a Docs import is; an
//          open reader (/read/<id>?streamingFrom=google-docs) is told through
//          lianki-push.
//
// The body becomes the sender's own book and nobody else's. Gate: a session,
// D1, reader v2, and flag `read.gdoc-stream` or the owner.
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { flagIn, type FlagValues } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { GDOC_LIMITS } from "@/lib/gdoc/fetch";
import { parseGdocHtml } from "@/lib/gdoc/parse";
import { isOwner } from "@/lib/owner";
import { checkBook } from "@/lib/read/book";
import { storeGdocBook } from "@/lib/read/gdoc-store";
import { readerV2On } from "@/lib/read/reader-book";
import type { D1Batch } from "@/lib/read/reader-store";
import { readJsonCapped, tooMany } from "@/lib/security/route-guard";

const DOC_ID = /^[A-Za-z0-9_-]{25,128}$/;
/** Sends per user per window (D1 counter). The userscript sends after a pause in the edits. */
const RATE = { windowMs: 10 * 60_000, max: 400 };

const fail = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });

function streamOn(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return readerV2On(flags, owner) && (owner || flagIn(flags, "read.gdoc-stream"));
}

async function gate() {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return null;
  if (dbBackend() !== "d1") return null;
  return streamOn(await readFlags(), isOwner(session.user.email ?? null)) ? userId : null;
}

/** Tell the user's open readers; a miss only means they update on the next change. */
function tellReaders(userId: string, book: string, hash: string) {
  try {
    const { env, ctx } = getCloudflareContext();
    const push = (env as unknown as { PUSH?: { fetch: typeof fetch } }).PUSH;
    if (!push) return;
    ctx.waitUntil(
      push
        .fetch("https://lianki-push/internal/read-stream", {
          method: "POST",
          body: JSON.stringify({ user: userId, book, hash }),
        })
        .catch(() => undefined),
    );
  } catch {
    // Not on the Worker.
  }
}

export async function GET() {
  return (await gate()) ? NextResponse.json({ on: true }) : fail("Not found", 404);
}

export async function POST(request: NextRequest) {
  const userId = await gate();
  if (!userId) return fail("Not found", 404);
  const limited = await tooMany(`read-gdoc-stream:${userId}`, RATE);
  if (limited) return limited;

  const body = await readJsonCapped(request, GDOC_LIMITS.maxHtmlChars + 4096);
  if (!body.ok) return fail(body.status === 413 ? "too-large" : "bad-body", body.status);
  const { docId, html, title } = (body.value ?? {}) as Record<string, unknown>;
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
  if (stored.changed) tellReaders(userId, stored.id, stored.hash);
  return NextResponse.json({ id: stored.id, changed: stored.changed, hash: stored.hash });
}
