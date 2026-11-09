/**
 * What /api/dev/permissions does once it has asked who is calling (the route
 * holds the isAdmin gate; `who` null means not an admin). Plain functions, so
 * the unit tests drive every answer. docs/secrets-and-auth.md, "Permissions".
 *
 * A non-admin gets an empty 404, like every /api/dev route. An answer never says
 * whether a typed address has an account: grants are on the address, and no user
 * table is read. Error bodies carry a code; the page words them in its locale.
 */
import { NextResponse } from "next/server";
import { sameOriginJsonPost } from "./security/same-origin";
import { PERMISSION_CACHE_MS } from "./permissions";
import {
  grantPermission,
  listGrants,
  revokePermission,
  type PermissionDb,
  type PermissionReadDb,
} from "./account-permission";

export type PermissionCaller = { id: string; email: string };

const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new NextResponse(null, { status: 404 });

async function state(db: PermissionDb, status = 200, extra: Record<string, unknown> = {}) {
  const grants = await listGrants(db as unknown as PermissionReadDb);
  return NextResponse.json(
    { grants, cacheSeconds: PERMISSION_CACHE_MS / 1000, ...extra },
    { status, headers: NO_STORE },
  );
}

export async function permissionsGet(who: PermissionCaller | null, db: () => PermissionDb | null) {
  const d1 = who ? db() : null;
  return d1 ? state(d1) : notFound();
}

export async function permissionsPost(
  req: Request,
  who: PermissionCaller | null,
  db: () => PermissionDb | null,
) {
  const d1 = who ? db() : null;
  if (!who || !d1) return notFound();
  if (!sameOriginJsonPost(req))
    return NextResponse.json({ error: "same-origin" }, { status: 403, headers: NO_STORE });
  const body = (await req.json().catch(() => ({}))) as {
    op?: unknown;
    email?: unknown;
    permission?: unknown;
  };
  if (body.op === "grant") {
    const result = await grantPermission(d1, body.email, body.permission, who);
    if (result === "bad-email" || result === "bad-permission")
      return state(d1, 400, { result, error: result });
    return state(d1, 200, { result });
  }
  if (body.op === "revoke") {
    const result = await revokePermission(d1, body.email, body.permission, who);
    if (result === "bad-email" || result === "bad-permission")
      return state(d1, 400, { result, error: result });
    if (result === "last-admin" || result === "not-granted")
      return state(d1, 409, { result, error: result });
    return state(d1, 200, { result });
  }
  return state(d1, 400, { error: "bad-op" });
}
