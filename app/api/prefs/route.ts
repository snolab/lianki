import { NextRequest, NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { apiTokenUser } from "@/lib/api-token-user";
import { dbBackend, getD1 } from "@/lib/d1";
import { devBridgeUser } from "@/lib/dev-bridge-user";
import { MAX_BODY_BYTES, patchBody } from "@/lib/prefs/schema";
import { UserPrefsD1Repo } from "@/lib/repos/userPrefsD1";

/**
 * The preferences that follow the account (docs/prefs-sync.md).
 *
 *   GET   /api/prefs[?since=<cursor>]  → { user, prefs: {key: {value, hlc}}, cursor }
 *   PATCH /api/prefs {ops: [{key, value, hlc}]} → { user, prefs: winners, rejected }
 *
 * Per-field last-write-wins by HLC (lib/repos/userPrefsD1.ts). The keys and
 * their schemas are lib/prefs/schema.ts; anything else is refused.
 *
 * The owner's dev page reaches it through the dev bridge (lib/dev-bridge-user.ts),
 * so it shares his settings with lianki.com. The `lianki settings` CLI reaches
 * it with `Authorization: Bearer lk_…` (lib/api-token-user.ts) — the only
 * route that takes an API token this way.
 *
 * D1 only: on the frozen Mongo rollback copy, reads are empty and writes 503,
 * so a rollback falls back to device-local preferences.
 */
const NO_STORE = { "Cache-Control": "private, no-store" };

async function who(req: Request) {
  const bridged = await devBridgeUser(req);
  if (bridged !== undefined) return bridged;
  const token = await apiTokenUser(req);
  return token === undefined ? await authUserOrNull() : token;
}

export async function GET(req: NextRequest) {
  const user = await who(req);
  if (!user)
    return NextResponse.json({ error: "Login required" }, { status: 401, headers: NO_STORE });
  if (dbBackend() !== "d1")
    return NextResponse.json({ user: user.id, prefs: {}, cursor: 0 }, { headers: NO_STORE });
  const since = Number(req.nextUrl.searchParams.get("since") ?? 0);
  const out = await new UserPrefsD1Repo(getD1(), user.id).read(
    Number.isFinite(since) && since > 0 ? since : 0,
  );
  return NextResponse.json({ user: user.id, ...out }, { headers: NO_STORE });
}

export async function PATCH(req: NextRequest) {
  const user = await who(req);
  if (!user)
    return NextResponse.json({ error: "Login required" }, { status: 401, headers: NO_STORE });
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "Not available" }, { status: 503, headers: NO_STORE });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES)
    return NextResponse.json({ error: "Too large" }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400, headers: NO_STORE });
  }
  const parsed = patchBody.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
  const out = await new UserPrefsD1Repo(getD1(), user.id).write(parsed.data.ops);
  return NextResponse.json({ user: user.id, ...out }, { headers: NO_STORE });
}
