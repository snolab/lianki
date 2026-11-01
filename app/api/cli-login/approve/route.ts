import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { approveRequest, sameOriginPost } from "@/lib/cli-login";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * POST /api/cli-login/approve {request, state} → {redirect}
 *
 * The Approve button of /cli-login (lib/cli-login.ts): the signed-in user's
 * pending request, same origin only, becomes a one-time code, and the answer
 * is the CLI's loopback URL carrying it.
 */
export async function POST(req: Request) {
  if (!sameOriginPost(req))
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
  const user = await authUserOrNull();
  if (!user)
    return NextResponse.json({ error: "Login required" }, { status: 401, headers: NO_STORE });
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "Not available" }, { status: 503, headers: NO_STORE });
  const body = (await req.json().catch(() => null)) as {
    request?: unknown;
    state?: unknown;
  } | null;
  const out = await approveRequest(getD1() as unknown as D1Like, {
    requestId: body?.request,
    userId: user.id,
    state: body?.state,
  });
  if (!out.ok)
    return NextResponse.json({ error: "Refused" }, { status: out.status, headers: NO_STORE });
  return NextResponse.json({ redirect: out.redirect }, { headers: NO_STORE });
}
