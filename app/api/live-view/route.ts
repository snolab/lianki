import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { liveViewKeys } from "@/lib/live-view/keys";
import { clearPointer, currentPointer, handleRequest, publicClaim } from "@/lib/live-view/server";
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
  // Content-Length and a streamed byte cap (413), a per-IP counter (429),
  // then the signed message (lib/live-view/server.ts handleRequest).
  const a = await handleRequest(req, getD1(), await liveViewKeys(), Date.now(), LOCAL_OK);
  const headers: Record<string, string> = { ...NO_STORE };
  if (a.retryAfterS) headers["retry-after"] = String(a.retryAfterS);
  return NextResponse.json(a.body, { status: a.status, headers });
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
