import { NextResponse } from "next/server";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import { hit } from "@/lib/security/throttle";
import { connectionContext, fail } from "@/lib/connections/route";
import {
  CONNECT_STARTS,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
  STATE_TTL_MS,
  authorizationUrl,
  googleConfig,
  newConnectState,
  sealState,
} from "@/lib/connections/google";

export const dynamic = "force-dynamic";

/**
 * POST /api/connections/google/start {return?} → {url}
 *
 * Starts the Google connection (docs/connections.md): a fresh state and PKCE
 * verifier sealed into an HttpOnly cookie for this user (10 min), and the
 * Google consent URL to go to. Same-origin JSON only, so another site cannot
 * start it for a signed-in user.
 */
export async function POST(req: Request) {
  if (!sameOriginJsonPost(req)) return fail("Forbidden", 403);
  const ctx = await connectionContext();
  if (ctx instanceof NextResponse) return ctx;
  const cfg = googleConfig(process.env, req.url);
  if (!cfg) return fail("not-configured", 503);

  const rate = await hit(ctx.db, `conn-google-start:${ctx.userId}`, CONNECT_STARTS);
  if (!rate.allowed)
    return fail("rate-limited", 429, {
      "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)),
    });

  const body = (await req.json().catch(() => null)) as { return?: unknown } | null;
  const { state, challenge } = await newConnectState(ctx.userId, body?.return);
  const sealed = await sealState(state, process.env.AUTH_SECRET);
  const res = NextResponse.json(
    { url: authorizationUrl(cfg, state.s, challenge, ctx.email ?? undefined) },
    { headers: { "cache-control": "no-store" } },
  );
  res.cookies.set(STATE_COOKIE, sealed, {
    httpOnly: true,
    secure: new URL(cfg.redirectUri).protocol === "https:",
    sameSite: "lax", // the callback is a top-level GET from accounts.google.com
    path: STATE_COOKIE_PATH,
    maxAge: STATE_TTL_MS / 1000,
  });
  return res;
}
