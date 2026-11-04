import { NextResponse, type NextRequest } from "next/server";
import { connectionContext } from "@/lib/connections/route";
import {
  ConnectionError,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
  checkState,
  exchangeCode,
  googleConfig,
  saveConnection,
  siteOrigin,
  validCode,
} from "@/lib/connections/google";

export const dynamic = "force-dynamic";

/**
 * GET /api/connections/google/callback?code&state — Google sends the user
 * back here (this exact URL is registered on the OAuth client). The state
 * must match the sealed cookie this user got from /start; the code is
 * exchanged with its PKCE verifier, the refresh token sealed into D1. Every
 * outcome redirects to our own page with a fixed reason word, never Google's
 * text, and the state cookie is cleared either way.
 */
export async function GET(req: NextRequest) {
  const origin = siteOrigin(process.env, req.url) ?? new URL(req.url).origin;
  const back = (path: string, result: string) => {
    const u = new URL(path, origin);
    u.searchParams.set("google", result);
    const res = NextResponse.redirect(u, 303);
    res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
    res.headers.set("cache-control", "no-store");
    res.headers.set("referrer-policy", "no-referrer");
    return res;
  };

  const ctx = await connectionContext();
  if (ctx instanceof NextResponse) return back("/connections", "signed-out");
  const cfg = googleConfig(process.env, req.url);
  if (!cfg) return back("/connections", "not-configured");

  const q = req.nextUrl.searchParams;
  const checked = await checkState(
    req.cookies.get(STATE_COOKIE)?.value,
    q.get("state"),
    ctx.userId,
    process.env.AUTH_SECRET,
  );
  if (!checked.ok) return back("/connections", "bad-state");
  const ret = checked.state.r;
  if (q.get("error")) return back(ret, q.get("error") === "access_denied" ? "denied" : "failed");
  const code = q.get("code");
  if (!validCode(code)) return back(ret, "failed");

  try {
    const ex = await exchangeCode(cfg, code, checked.state.v);
    await saveConnection(ctx.db, ctx.userId, ex, process.env.AUTH_SECRET);
    console.log("connections.google.connected", { user: ctx.userId, scopes: ex.scopes.length });
    return back(ret, "connected");
  } catch (err) {
    console.error("connections.google.callback-failed", {
      user: ctx.userId,
      code: err instanceof ConnectionError ? err.code : "error",
    });
    return back(ret, "failed");
  }
}
