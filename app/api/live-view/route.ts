import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { liveViewKeys } from "@/lib/live-view/keys";
import { clearPointer, currentPointer, handlePost, publicClaim } from "@/lib/live-view/server";
import { isOwner } from "@/lib/owner";

/**
 * The live-view pointer (docs/live-view.md, lib/live-view/server.ts).
 *
 * - POST `{token}`: from the owner's Mac (scripts/dev/live-view.ts), signed
 *   with the dev key — on, off or status. No session: the signature decides.
 * - GET: the owner's session only (404 for anyone else): the current pointer.
 * - DELETE: the owner's session only: stop (clears the pointer).
 *
 * Not under /api/dev on purpose: the Mac's POST carries no session, and
 * Cloudflare Access on /api/dev would stop it.
 */
const NO_STORE = { "cache-control": "no-store" };
/** Dev builds may point at http://localhost dev servers; production never. */
const LOCAL_OK = process.env.NODE_ENV !== "production";
const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });

export const POST = async (req: Request) => {
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "D1 only" }, { status: 503, headers: NO_STORE });
  const text = await req.text();
  if (text.length > 4096)
    return NextResponse.json({ error: "too large" }, { status: 413, headers: NO_STORE });
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  const a = await handlePost(body, getD1(), await liveViewKeys(), Date.now(), LOCAL_OK);
  return NextResponse.json(a.body, { status: a.status, headers: NO_STORE });
};

export const GET = async () => {
  const user = await authUserOrNull();
  if (!isOwner(user?.email) || dbBackend() !== "d1") return notFound();
  const cur = await currentPointer(getD1(), await liveViewKeys(), Date.now(), LOCAL_OK);
  return NextResponse.json(
    cur ? { on: true, token: cur.token, claim: publicClaim(cur.claim) } : { on: false },
    { headers: NO_STORE },
  );
};

export const DELETE = async () => {
  const user = await authUserOrNull();
  if (!isOwner(user?.email) || dbBackend() !== "d1") return notFound();
  await clearPointer(getD1(), Date.now());
  return NextResponse.json({ on: false }, { headers: NO_STORE });
};
