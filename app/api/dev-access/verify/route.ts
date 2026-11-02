import { NextResponse } from "next/server";
import { DEV_BRIDGE_HEADER, devBridgeMatches } from "@/lib/dev-bridge";
import { dbBackend, getD1 } from "@/lib/d1";
import { activeIds, verifyToken } from "@/lib/dev-access";
import type { DevAccessDb } from "@/lib/dev-access";
import { ownerEmails } from "@/lib/owner";

/**
 * For the dev server's gate only (scripts/dev/preview-gate.ts): it proves
 * itself with DEV_BRIDGE_SECRET, as on the other bridge routes. Without it:
 * 401, so a token cannot be tested from anywhere else.
 *
 *   {token}  → 200 {id, email, kind, sessionUntilMs}, or 404. A handoff is used up.
 *   {ids}    → 200 {active: [...]}: the ids whose sessions may go on.
 *
 * Nothing here logs the token.
 */
export const POST = async (req: Request) => {
  if (!devBridgeMatches(req.headers.get(DEV_BRIDGE_HEADER), process.env.DEV_BRIDGE_SECRET))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (dbBackend() !== "d1") return NextResponse.json({ error: "D1 only" }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { token?: unknown; ids?: unknown };
  const db = getD1() as unknown as DevAccessDb;
  const owners = ownerEmails();
  const headers = { "cache-control": "no-store" };
  if (Array.isArray(body.ids)) {
    const ids = body.ids.filter((x): x is string => typeof x === "string" && x.length <= 40);
    return NextResponse.json({ active: await activeIds(db, ids, owners) }, { headers });
  }
  const v = await verifyToken(db, body.token, owners);
  if (!v) return NextResponse.json({ error: "no such token" }, { status: 404, headers });
  return NextResponse.json(v, { headers });
};
