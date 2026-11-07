import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { disallowBoxUser } from "@/lib/box-oauth/allowlist";
import { notifyBoxClosed } from "@/lib/box-oauth/push-close";
import type { BoxDb } from "@/lib/box-oauth/store";
import {
  allowByEmail,
  listAllPreviews,
  listAllowed,
  revokePreview,
  type CustomDb,
} from "@/lib/live-view/custom";
import { isOwner } from "@/lib/owner";
import { sameOriginJsonPost } from "@/lib/security/same-origin";

/**
 * Owner-only: who may register a custom frontend (docs/custom-frontend.md),
 * and every active preview. 404 for anyone else. The list is the one my-box
 * allowlist, shared with boxes (lib/box-oauth/allowlist.ts, /dev/box-clients).
 * - GET → { allowed: [...], previews: [...] };
 * - POST (same-origin JSON) `{ op: "add", email }` | `{ op: "remove", userId }`
 *   (also revokes that user's previews and box) | `{ op: "revoke", id }`. Audited.
 */
const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new NextResponse(null, { status: 404 });

async function owner() {
  const user = await authUserOrNull();
  return isOwner(user?.email) && user?.id ? user : null;
}

const db = () => getD1() as unknown as CustomDb;

async function state() {
  return { allowed: await listAllowed(db()), previews: await listAllPreviews(db()) };
}

export const GET = async () => {
  if (!(await owner()) || dbBackend() !== "d1") return notFound();
  return NextResponse.json(await state(), { headers: NO_STORE });
};

export const POST = async (req: Request) => {
  const by = await owner();
  if (!by || dbBackend() !== "d1") return notFound();
  if (!sameOriginJsonPost(req))
    return NextResponse.json({ error: "Same-origin JSON only" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bad = (error: string) => NextResponse.json({ error }, { status: 400, headers: NO_STORE });
  if (b.op === "add") {
    if (typeof b.email !== "string" || !b.email.includes("@") || b.email.length > 200)
      return bad("email required");
    if (!(await allowByEmail(db(), b.email, by.id))) return bad("no user with that email");
  } else if (b.op === "remove") {
    if (typeof b.userId !== "string" || !b.userId) return bad("userId required");
    // The same list as boxes: removing someone also revokes their box.
    const { revokedClientId } = await disallowBoxUser(db() as unknown as BoxDb, b.userId, by.id);
    if (revokedClientId) await notifyBoxClosed(revokedClientId);
  } else if (b.op === "revoke") {
    if (typeof b.id !== "string") return bad("id required");
    await revokePreview(db(), b.id, { userId: by.id, owner: true });
  } else return bad("op must be add, remove or revoke");
  return NextResponse.json(await state(), { headers: NO_STORE });
};
