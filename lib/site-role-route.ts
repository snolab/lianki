/**
 * What /api/dev/owners does once it has asked who is calling (the route holds
 * the isOwner gate; `who` null means not the owner). Plain functions, so the
 * unit tests can drive every answer. docs/secrets-and-auth.md, "The owner role".
 *
 * A non-owner gets an empty 404, like every /api/dev route. An answer never
 * says whether a typed address has an account: the role is on the address, and
 * no user table is read.
 */
import { NextResponse } from "next/server";
import { OWNER_CACHE_MS } from "./owner";
import { sameOriginJsonPost } from "./security/same-origin";
import {
  grantOwner,
  listOwners,
  revokeOwner,
  type OwnerReadDb,
  type SiteRoleDb,
} from "./site-role";

export type OwnerCaller = { id: string; email: string };

const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new NextResponse(null, { status: 404 });
const bad = (error: string) => NextResponse.json({ error }, { status: 400, headers: NO_STORE });
const BAD_EMAIL = "不是一个完整的邮箱地址";

async function state(db: SiteRoleDb, status = 200, extra: Record<string, unknown> = {}) {
  const owners = await listOwners(db as unknown as OwnerReadDb);
  return NextResponse.json(
    { owners, cacheSeconds: OWNER_CACHE_MS / 1000, ...extra },
    { status, headers: NO_STORE },
  );
}

export async function ownersGet(who: OwnerCaller | null, db: () => SiteRoleDb | null) {
  const d1 = who ? db() : null;
  return d1 ? state(d1) : notFound();
}

export async function ownersPost(
  req: Request,
  who: OwnerCaller | null,
  db: () => SiteRoleDb | null,
) {
  const d1 = who ? db() : null;
  if (!who || !d1) return notFound();
  if (!sameOriginJsonPost(req))
    return NextResponse.json({ error: "Same-origin JSON only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { op?: unknown; email?: unknown };
  if (body.op === "grant") {
    const result = await grantOwner(d1, body.email, who);
    if (result === "bad-email") return bad(BAD_EMAIL);
    return state(d1, 200, { result });
  }
  if (body.op === "revoke") {
    const result = await revokeOwner(d1, body.email, who);
    if (result === "bad-email") return bad(BAD_EMAIL);
    if (result === "last-owner")
      return state(d1, 409, { result, error: "这是唯一的所有者，不能撤销。先授予另一位。" });
    if (result === "not-owner") return state(d1, 409, { result, error: "这个地址不是所有者。" });
    return state(d1, 200, { result });
  }
  return bad("op must be grant or revoke");
}
