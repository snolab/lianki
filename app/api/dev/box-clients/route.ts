import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { auth } from "@/auth";
import { runtimeNodeEnv } from "@/lib/auth-env";
import { dbBackend, getD1 } from "@/lib/d1";
import { BOX_SCOPES, SCOPE_REFRESH, redirectUriFor } from "@/lib/box-oauth/rules";
import { allowBoxUser, disallowBoxUser, listBoxAllowed } from "@/lib/box-oauth/allowlist";
import {
  insertBinding,
  isBoxAllowed,
  listBindings,
  revokeBox,
  setBoxChat,
  setBoxEval,
  validNewBox,
  type BoxDb,
} from "@/lib/box-oauth/store";
import { notifyBoxClosed, notifyBoxEvalEnded } from "@/lib/box-oauth/push-close";
import { isAdmin } from "@/lib/permissions";
import { audit, type AuditDb } from "@/lib/security/audit-log";
import { sameOriginJsonPost } from "@/lib/security/same-origin";

/**
 * Owner-only: which box may sign in as which account (docs/box-oauth.md). 404
 * for anyone else. Works while the flag is off, so a box can be set up before
 * it is turned on.
 * - GET → { boxes: [...], allowed: [...] };
 * - POST (same-origin JSON) `{ op: "allow", who }` (email or user id) |
 *   `{ op: "disallow", userId }`: the my-box allowlist ("Who may have a box";
 *   removing someone also revokes their box and stops their previews) |
 *   `{ op: "add", origin, email, scopes }` (the account must be on the list) |
 *   `{ op: "chat", clientId, on }`: box:chat on or off (a site owner's box only;
 *   off also removes box:eval) |
 *   `{ op: "eval", clientId, on }`: box:eval on or off (a site owner's box that
 *   holds box:chat) |
 *   `{ op: "revoke", clientId }`: the one action that ends a box and its tokens.
 */
const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new NextResponse(null, { status: 404 });

async function owner() {
  const user = await authUserOrNull();
  return isAdmin(user?.email) && user?.id ? user : null;
}

const db = () => getD1() as unknown as BoxDb;

async function state() {
  return { boxes: await listBindings(db()), allowed: await listBoxAllowed(db()) };
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
  const bad = (error: string, status = 400) =>
    NextResponse.json({ error }, { status, headers: NO_STORE });

  if (b.op === "revoke") {
    if (typeof b.clientId !== "string") return bad("clientId required");
    if (!(await revokeBox(db(), b.clientId, by.id))) return bad("no live box with that client");
    await notifyBoxClosed(b.clientId);
    return NextResponse.json(await state(), { headers: NO_STORE });
  }
  if (b.op === "chat") {
    // box:chat (docs/box-oauth.md, "Chat on the owner's box"): a site owner's box only.
    if (typeof b.clientId !== "string") return bad("clientId required");
    if (typeof b.on !== "boolean") return bad("on must be true or false");
    const r = await setBoxChat(db(), b.clientId, b.on, by.id);
    if (r === "no-box") return bad("no live box with that client");
    if (r === "not-owner") return bad("box:chat is only for a box bound to a site owner", 403);
    if (!b.on) await notifyBoxClosed(b.clientId);
    return NextResponse.json(await state(), { headers: NO_STORE });
  }
  if (b.op === "eval") {
    // box:eval (docs/box-oauth.md, "Code on the owner's box"): a site owner's
    // box that holds box:chat; never implied by it.
    if (typeof b.clientId !== "string") return bad("clientId required");
    if (typeof b.on !== "boolean") return bad("on must be true or false");
    const r = await setBoxEval(db(), b.clientId, b.on, by.id);
    if (r === "no-box") return bad("no live box with that client");
    if (r === "not-owner") return bad("box:eval is only for a box bound to a site owner", 403);
    if (r === "needs-chat") return bad("turn on box:chat first", 409);
    if (!b.on) await notifyBoxEvalEnded(b.clientId);
    return NextResponse.json(await state(), { headers: NO_STORE });
  }
  if (b.op === "allow") {
    if (typeof b.who !== "string" || !b.who.trim() || b.who.length > 200)
      return bad("who required: an email or a user id");
    if (!(await allowBoxUser(db(), b.who, by.id))) return bad("no user with that email or id");
    return NextResponse.json(await state(), { headers: NO_STORE });
  }
  if (b.op === "disallow") {
    if (typeof b.userId !== "string" || !b.userId) return bad("userId required");
    const { revokedClientId } = await disallowBoxUser(db(), b.userId, by.id);
    if (revokedClientId) await notifyBoxClosed(revokedClientId);
    return NextResponse.json(await state(), { headers: NO_STORE });
  }
  if (b.op !== "add") return bad("op must be allow, disallow, add, chat, eval or revoke");

  const problem = validNewBox(b.origin, b.scopes, runtimeNodeEnv() === "development");
  if (problem) return bad(problem);
  if (typeof b.email !== "string" || !b.email.includes("@") || b.email.length > 200)
    return bad("email required");
  const target = await db()
    .prepare("SELECT id FROM user WHERE lower(email) = lower(?1)")
    .bind(b.email)
    .first<{ id: string }>();
  if (!target) return bad("no user with that email");
  // Default deny: only an account on the my-box allowlist gets a box.
  if (!(await isBoxAllowed(db(), target.id))) {
    await audit(db() as unknown as AuditDb, {
      kind: "box.bind-refused",
      actor: by.id,
      subject: target.id,
      detail: "not on the box allowlist",
    });
    return bad("add this account to the box allowlist first", 403);
  }

  const origin = b.origin as string;
  const scopes = [...(b.scopes as string[]), SCOPE_REFRESH].filter((s) =>
    (BOX_SCOPES as readonly string[]).includes(s),
  );
  let created: { client_id: string };
  try {
    created = (await (
      auth.api as unknown as {
        adminCreateOAuthClient(a: {
          headers: Headers;
          body: Record<string, unknown>;
        }): Promise<{ client_id: string }>;
      }
    ).adminCreateOAuthClient({
      headers: req.headers,
      body: {
        redirect_uris: [redirectUriFor(origin)],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: scopes.join(" "),
        client_name: "Lianki box",
        // Only a dev server's http://127.0.0.1 is native: the plugin allows http
        // nowhere else, and a real box is always https (validNewBox).
        application_type: origin.startsWith("https:") ? "web" : "native",
        skip_consent: true,
        require_pkce: true,
      },
    })) as { client_id: string };
  } catch (e) {
    // The plugin's refusal, as an answer: nothing was created.
    const body = (e as { body?: { error_description?: string; error?: string } }).body;
    return bad(body?.error_description ?? body?.error ?? "could not create the client");
  }
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
    { clientId: created.client_id, ...(await state()) },
    { headers: NO_STORE },
  );
};
