import { NextResponse } from "next/server";
import { sameOriginJsonPost } from "@/lib/security/same-origin";
import { hit } from "@/lib/security/throttle";
import { connectionContext, fail } from "@/lib/connections/route";
import {
  ConnectionError,
  TOKEN_REQUESTS,
  accessToken,
  googleConfig,
  pickerConfig,
} from "@/lib/connections/google";

export const dynamic = "force-dynamic";

const STATUS: Record<ConnectionError["code"], number> = {
  "not-configured": 503,
  "not-connected": 409,
  reconnect: 409,
  "no-drive-scope": 409,
  "google-failed": 502,
};

/**
 * POST /api/connections/google/picker → {accessToken, expiresAt, apiKey, appId}
 *
 * What the Google Picker needs in the browser to let the user pick a doc (so
 * `drive.file` covers it): a short-lived `drive.file` access token for this
 * user, the Picker's browser key and the project number. The token stays in
 * the page's memory for the Picker; the refresh token never leaves the Worker.
 * 503 `not-configured` until GOOGLE_PICKER_API_KEY is set.
 */
export async function POST(req: Request) {
  if (!sameOriginJsonPost(req)) return fail("Forbidden", 403);
  const ctx = await connectionContext();
  if (ctx instanceof NextResponse) return ctx;
  const cfg = googleConfig(process.env, req.url);
  const picker = pickerConfig(process.env);
  if (!cfg || !picker) return fail("not-configured", 503);

  const rate = await hit(ctx.db, `conn-google-token:${ctx.userId}`, TOKEN_REQUESTS);
  if (!rate.allowed)
    return fail("rate-limited", 429, {
      "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)),
    });

  try {
    const t = await accessToken(ctx.db, ctx.userId, cfg, process.env.AUTH_SECRET);
    return NextResponse.json(
      { accessToken: t.token, expiresAt: t.expiresAt, apiKey: picker.apiKey, appId: picker.appId },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const code = err instanceof ConnectionError ? err.code : "google-failed";
    if (code === "google-failed")
      console.error("connections.google.token-failed", { user: ctx.userId });
    return fail(code, STATUS[code]);
  }
}
