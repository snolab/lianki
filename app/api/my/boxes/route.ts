import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import type { BoxDb } from "@/lib/box-oauth/store";
import { myBox, revokeMyBox } from "@/lib/box-oauth/my-box";
import { notifyBoxClosed } from "@/lib/box-oauth/push-close";
import { sameOriginJsonPost } from "@/lib/security/same-origin";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET() {
  const user = await authUserOrNull();
  if (!user?.id) return json({ error: "unauthorized" }, 401);
  if (dbBackend() !== "d1") return json({ error: "unavailable" }, 503);
  return json({ box: await myBox(getD1() as unknown as BoxDb, user.id) });
}

export async function POST(req: Request) {
  const user = await authUserOrNull();
  if (!user?.id) return json({ error: "unauthorized" }, 401);
  if (!sameOriginJsonPost(req)) return json({ error: "same-origin-json-only" }, 403);
  if (dbBackend() !== "d1") return json({ error: "unavailable" }, 503);
  const body = (await req.json().catch(() => null)) as { op?: unknown; clientId?: unknown } | null;
  if (body?.op !== "revoke") return json({ error: "invalid-operation" }, 400);
  const revoked = await revokeMyBox(
    { db: getD1() as unknown as BoxDb, userId: user.id, notify: notifyBoxClosed },
    body.clientId,
  );
  return revoked ? json({ box: null }) : json({ error: "not-found" }, 404);
}
