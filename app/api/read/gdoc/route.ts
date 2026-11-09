// POST /api/read/gdoc { url } — import a Google Doc into /read as a book.
//
// Docs shared "anyone with the link" come from the public HTML export. With
// `via: "drive"`, a private doc comes through the user's Google connection
// instead (Drive API files.export with their drive.file token; lib/gdoc/
// drive.ts, docs/connections.md), once they picked it in the Google Picker;
// that path is also gated on `connectionsOn` (flag connections.google, or the
// owner). The URL is reduced to a
// document id (lib/gdoc/url.ts) and only Google's export URL for that id is
// fetched. The book is the importer's own, never shared. Importing the same
// doc again updates that book in place: same id, and the FSRS state of every
// unchanged line carried over to the new text's sentence ids.
//
// The text goes through the import pipeline (lib/read/prep.ts): its shape
// detected (a raw transcript is offered the AI polish in the reader), then
// cut into bite-size paragraphs, each line in its own language. Cards of
// sentences whose words did not change follow them to their new ids.
//
// Gate: as every reader-v2 route (lib/read/reader-route.ts): a session, D1,
// and the material being the user's. Rate-limited per user.

import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { hit } from "@/lib/security/throttle";
import { fetchGdocHtml, GdocError } from "@/lib/gdoc/fetch";
import { parseGdocHtml } from "@/lib/gdoc/parse";
import { gdocIdOf } from "@/lib/gdoc/url";
import { fetchDriveHtml } from "@/lib/gdoc/drive";
import { connectionsOn } from "@/lib/connections/gate";
import { ConnectionError, accessToken, forget, googleConfig } from "@/lib/connections/google";
import type { D1Like } from "@/lib/d1/types";
import { checkBook } from "@/lib/read/book";
import { storeGdocBook } from "@/lib/read/gdoc-store";
import type { D1Batch } from "@/lib/read/reader-store";

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

const CONN_STATUS: Record<ConnectionError["code"], number> = {
  "not-configured": 503,
  "not-connected": 409,
  reconnect: 409,
  "no-drive-scope": 409,
  "google-failed": 502,
};

const STATUS: Record<GdocError["code"], number> = {
  "not-shared": 422,
  "not-granted": 422,
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
  const flags = await readFlags();
  const owner = isDev(session.user.email ?? null);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("bad-url", 400);
  }
  const id = gdocIdOf((body as { url?: unknown } | null)?.url);
  if (!id) return fail("bad-url", 400);
  const via = (body as { via?: unknown }).via;
  if (via !== undefined && via !== "drive") return fail("bad-url", 400);
  const drive = via === "drive";
  if (drive && !connectionsOn(flags, owner)) return fail("Not found", 404);

  const rate = await hit(getD1(), `read-gdoc:${userId}`, RATE);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  let parsed;
  try {
    let doc;
    if (drive) {
      const cfg = googleConfig(process.env, request.url);
      if (!cfg) return fail("not-configured", 503);
      const t = await accessToken(
        getD1() as unknown as D1Like,
        userId,
        cfg,
        process.env.AUTH_SECRET,
      );
      doc = await fetchDriveHtml(id, t.token);
    } else doc = await fetchGdocHtml(id);
    parsed = parseGdocHtml(doc.html, doc.title);
  } catch (err) {
    if (err instanceof GdocError) return fail(err.code, STATUS[err.code]);
    if (err instanceof ConnectionError) {
      // Google refused the token itself: drop it from memory, refresh next time.
      if (err.code === "reconnect") forget(userId);
      return fail(err.code, CONN_STATUS[err.code]);
    }
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
  const db = getD1() as unknown as D1Batch;
  return NextResponse.json(await storeGdocBook(db, userId, id, checked.book));
}
