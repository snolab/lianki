import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { auth } from "@/auth";
import { runtimeNodeEnv } from "@/lib/auth-env";
import { dbBackend, getD1 } from "@/lib/d1";
import { BOX_SCOPES, SCOPE_REFRESH, redirectUriFor } from "@/lib/box-oauth/rules";
import {
  insertBinding,
  listBindings,
  revokeBox,
  validNewBox,
  type BoxDb,
} from "@/lib/box-oauth/store";
import { isOwner } from "@/lib/owner";
import { sameOriginJsonPost } from "@/lib/security/same-origin";

/**
 * Owner-only: which box may sign in as which account (docs/box-oauth.md). 404
 * for anyone else. Works while the flag is off, so a box can be set up before
 * it is turned on.
 * - GET → { boxes: [...] };
 * - POST (same-origin JSON) `{ op: "add", origin, email, scopes }` |
 *   `{ op: "revoke", clientId }`: the one action that ends a box and its tokens.
 */
const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new NextResponse(null, { status: 404 });

async function owner() {
  const user = await authUserOrNull();
  return isOwner(user?.email) && user?.id ? user : null;
}

const db = () => getD1() as unknown as BoxDb;

export const GET = async () => {
  if (!(await owner()) || dbBackend() !== "d1") return notFound();
  return NextResponse.json({ boxes: await listBindings(db()) }, { headers: NO_STORE });
};

export const POST = async (req: Request) => {
  const by = await owner();
  if (!by || dbBackend() !== "d1") return notFound();
  if (!sameOriginJsonPost(req))
    return NextResponse.json({ error: "Same-origin JSON only" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bad = (error: string, status = 400) =>
    NextResponse.json({ error }, { status, headers: NO_STORE });

  if (b.op === "revoke") {
    if (typeof b.clientId !== "string") return bad("clientId required");
    if (!(await revokeBox(db(), b.clientId, by.id))) return bad("no live box with that client");
    return NextResponse.json({ boxes: await listBindings(db()) }, { headers: NO_STORE });
  }
  if (b.op !== "add") return bad("op must be add or revoke");

  const problem = validNewBox(b.origin, b.scopes, runtimeNodeEnv() === "development");
  if (problem) return bad(problem);
  if (typeof b.email !== "string" || !b.email.includes("@") || b.email.length > 200)
    return bad("email required");
  const target = await db()
    .prepare("SELECT id FROM user WHERE lower(email) = lower(?1)")
    .bind(b.email)
    .first<{ id: string }>();
  if (!target) return bad("no user with that email");

  const origin = b.origin as string;
  const scopes = [...(b.scopes as string[]), SCOPE_REFRESH].filter((s) =>
    (BOX_SCOPES as readonly string[]).includes(s),
  );
  const created = (await (
    auth.api as unknown as {
      adminCreateOAuthClient(a: { body: Record<string, unknown> }): Promise<{ client_id: string }>;
    }
  ).adminCreateOAuthClient({
    body: {
      redirect_uris: [redirectUriFor(origin)],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: scopes.join(" "),
      client_name: "Lianki box",
      type: "user-agent-based",
      skip_consent: true,
      require_pkce: true,
    },
  })) as { client_id: string };
  const ok = await insertBinding(
    db(),
    { clientId: created.client_id, origin, userId: target.id, scopes },
    by.id,
  );
  if (!ok) {
    // Keep nothing behind for a box that was refused.
    await db().prepare("DELETE FROM oauthClient WHERE clientId = ?1").bind(created.client_id).run();
    return bad("that origin or account already has a box", 409);
  }
  return NextResponse.json(
    { clientId: created.client_id, boxes: await listBindings(db()) },
    { headers: NO_STORE },
  );
};
