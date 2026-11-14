/**
 * /api/token: the signed-in account's API tokens (lib/api-tokens.ts), for the
 * API Tokens section of /preferences. A browser session only: a token can
 * never list, make or revoke tokens (the route reads the session, never an
 * Authorization header).
 *
 *   GET                                  → {account, scopes, expiryDays, maxExpiryDays, tokens}
 *   POST   {name, scopes, expiry}        → {token, id, …}  the secret, this once
 *   DELETE {id}                          → {ok}            one click on the page
 *
 * `expiry` is {days} (EXPIRY_DAYS) or {date}; there is no default. Writes are
 * JSON from this origin (a cross-site form cannot send JSON; a cross-site
 * fetch carries its own Origin), and each is in the security audit log.
 *
 * `eval` (OWNER_SCOPES) is listed and accepted only when the session's account
 * holds the `dev` permission, read now (`siteOwner`), and only with an expiry of at most
 * EVAL_MAX_DAYS. For anyone else it does not exist: the same 400 as any
 * unknown permission.
 */
import type { D1Like } from "@/lib/d1/types";
import {
  EVAL_MAX_DAYS,
  EXPIRY_DAYS,
  FORBIDDEN_SCOPES,
  MAX_EXPIRY_DAYS,
  OWNER_SCOPES,
  SCOPES,
  type TokenOwner,
  cleanTokenName,
  createToken,
  listTokens,
  parseExpiry,
  parseScopes,
  revokeToken,
  tagOf,
} from "@/lib/api-tokens";
import { type AuditDb, audit } from "@/lib/security/audit-log";

export type TokenApiDeps = {
  /** The session's account, or null for a guest. */
  who: () => Promise<TokenOwner | null>;
  db: () => D1Like & AuditDb;
  /** Does this account hold `dev` now (lib/permissions.ts)? Only then is `eval` offered or accepted. Absent: no. */
  siteOwner?: (userId: string) => Promise<boolean>;
  /** Revoked tokens' listening sockets close (lib/push-chat-tokens.ts). */
  revoked: (ids: string[]) => Promise<void>;
  /** At most this many live tokens per account. */
  maxTokens?: number;
  now?: () => number;
};

export const MAX_TOKENS = 50;
const NO_STORE = { "cache-control": "private, no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** JSON from this origin (or a non-browser client, which sends no Origin). */
export function jsonWrite(req: Request): boolean {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return false;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  return origin === null || origin === new URL(req.url).origin;
}

export async function tokenApi(req: Request, deps: TokenApiDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const owner = await deps.who();
  if (!owner) return json({ error: "Sign in" }, 401);
  const db = deps.db();

  const isOwner = async () => (deps.siteOwner ? deps.siteOwner(owner.userId) : false);
  if (req.method === "GET") {
    const site = await isOwner();
    return json({
      account: owner.email,
      scopes: site ? SCOPES : SCOPES.filter((s) => !OWNER_SCOPES.includes(s.id)),
      expiryDays: EXPIRY_DAYS,
      maxExpiryDays: MAX_EXPIRY_DAYS,
      ...(site ? { evalMaxDays: EVAL_MAX_DAYS } : {}),
      tokens: await listTokens(db, owner, now),
    });
  }

  if (req.method !== "POST" && req.method !== "DELETE") return json({ error: "Method" }, 405);
  if (!jsonWrite(req)) return json({ error: "Forbidden" }, 403);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "Expected JSON" }, 400);

  if (req.method === "DELETE") {
    const gone = await revokeToken(db, owner, body.id);
    if (!gone) return json({ error: "Not found" }, 404);
    await audit(db, {
      kind: "api-token.revoke",
      actor: owner.userId,
      subject: tagOf(gone.id),
      detail: `${gone.name} [${gone.scopes.join(" ")}]`,
    });
    await deps.revoked([gone.id]);
    return json({ ok: true });
  }

  const name = cleanTokenName(body.name);
  if (!name) return json({ error: "name: 1–40 characters" }, 400);
  if (
    Array.isArray(body.scopes) &&
    body.scopes.some((s) => (FORBIDDEN_SCOPES as readonly unknown[]).includes(s))
  )
    return json({ error: "scopes: that permission does not exist for tokens" }, 400);
  // An owner-only permission asks for the `dev` grant first; for anyone else it does not exist.
  const wantsOwner =
    Array.isArray(body.scopes) &&
    body.scopes.some((s) => (OWNER_SCOPES as readonly unknown[]).includes(s));
  if (wantsOwner && !(await isOwner()))
    return json({ error: "scopes: that permission does not exist for tokens" }, 400);
  const scopes = parseScopes(body.scopes, { owner: wantsOwner });
  if (!scopes) return json({ error: "scopes: pick at least one permission" }, 400);
  const expiresAt = parseExpiry(body.expiry, now);
  if (!expiresAt)
    return json({ error: `expiry: pick a duration or a date up to ${MAX_EXPIRY_DAYS} days` }, 400);
  const capped =
    Array.isArray(body.scopes) && body.scopes.some((x) => x === "eval" || x === "recordings:read");
  if (capped && expiresAt.getTime() > now + EVAL_MAX_DAYS * 86_400_000)
    return json(
      {
        error: `expiry: a token with an owner permission (eval, recordings:read) lasts at most ${EVAL_MAX_DAYS} days`,
      },
      400,
    );
  const live = (await listTokens(db, owner, now)).filter((t) => !t.expired).length;
  if (live >= (deps.maxTokens ?? MAX_TOKENS))
    return json({ error: "Too many tokens: revoke one first" }, 409);
  const { token, id } = await createToken(db, owner, { name, scopes, expiresAt }, now);
  await audit(
    db,
    {
      kind: "api-token.create",
      actor: owner.userId,
      subject: tagOf(id),
      detail: `${name} [${scopes.join(" ")}] until ${expiresAt.toISOString()}`,
    },
    now,
  );
  // The secret, this once. The page shows it and forgets it.
  return json({
    token,
    id,
    name,
    scopes,
    expiresAt: expiresAt.toISOString(),
    account: owner.email,
  });
}
