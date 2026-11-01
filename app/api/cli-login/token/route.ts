import { NextResponse } from "next/server";
import { EXCHANGES_PER_IP, exchangeCode, revokeSelf } from "@/lib/cli-login";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { clientIp, hit, ipKey, type ThrottleDb } from "@/lib/security/throttle";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

/**
 * POST   /api/cli-login/token {code, code_verifier, redirect_uri} → {token, id, name, email}
 * DELETE /api/cli-login/token  (Authorization: Bearer lk_…)       → {ok}
 *
 * The CLI's side of the browser login (lib/cli-login.ts): the one-time code
 * and its PKCE verifier for an API token, in the body only; rate-limited per
 * IP. DELETE is `lianki auth logout`: a token revokes itself, nothing else.
 */
export async function POST(req: Request) {
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "Not available" }, { status: 503, headers: NO_STORE });
  const db = getD1() as unknown as D1Like;
  const limit = await hit(
    db as unknown as ThrottleDb,
    ipKey("cli-code", clientIp(req.headers)),
    EXCHANGES_PER_IP,
  );
  if (!limit.allowed)
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { ...NO_STORE, "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const out = await exchangeCode(db, {
    code: body?.code,
    verifier: body?.code_verifier,
    redirectUri: body?.redirect_uri,
  });
  if (!out.ok)
    return NextResponse.json({ error: out.error }, { status: out.status, headers: NO_STORE });
  return NextResponse.json(
    { token: out.token, id: out.tokenHash, name: out.name, email: out.email },
    { headers: NO_STORE },
  );
}

export async function DELETE(req: Request) {
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "Not available" }, { status: 503, headers: NO_STORE });
  const m = /^Bearer (lk_[0-9a-f]{64})$/.exec(req.headers.get("Authorization") ?? "");
  if (!m)
    return NextResponse.json(
      { error: "Bearer token required" },
      { status: 401, headers: NO_STORE },
    );
  const ok = await revokeSelf(getD1() as unknown as D1Like, m[1]);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404, headers: NO_STORE });
}
