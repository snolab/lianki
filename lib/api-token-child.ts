/**
 * Child tokens (docs/secrets-and-auth.md, "Child tokens"): a lane's token mints
 * short-lived tokens for its own subagents, so each subagent posts in the chat
 * under its own name ("claude·子1", shown 「小克·子1」) without the owner
 * making a token for each one.
 *
 *   POST   /api/token/child  Bearer <parent>  {name, scopes?, ttlMinutes?} → {token, id, name, scopes, expiresAt}
 *   GET    /api/token/child  Bearer <parent>                                → {children: [...]}
 *   DELETE /api/token/child  Bearer <parent>  {id}                          → {ok}
 *
 * Rules, all checked here at mint and again by checkToken at every use:
 * - The parent holds `token:mint-child` (MINT_CHILD), granted by the owner on
 *   the token's row, and its account holds `dev` now. Made by hand: not an
 *   OAuth app's token, not itself a child (no grandchildren).
 * - The child's permissions are a subset of the parent's and never include
 *   `token:mint-child`. checkToken intersects them with the parent's on every
 *   use, so narrowing the parent narrows its children.
 * - The child expires at most `tokens.childMaxMinutes` from now and never
 *   after its parent; `tokens.childDefaultMinutes` when none is asked for.
 * - At most `tokens.childMaxLive` live children per parent; live names unique.
 * - Revoking the parent deletes its children (revokeToken); a parent expired,
 *   gone or without `token:mint-child`, or the flag `tokens.child` off, makes
 *   every child "unknown" at once (checkToken), with no sweep.
 * - Mint and revoke are in the security audit log (who, the child's name,
 *   permissions, expiry); never the secret. The secret is returned once, to
 *   the caller, and is never logged or posted.
 *
 * Flag `tokens.child` off: this route is a 404 and existing children are dead.
 */
import {
  MAX_NAME,
  MINT_CHILD,
  type ScopeId,
  checkToken,
  cleanTokenName,
  isExpired,
  newSecret,
  parseScopes,
  rowScopes,
  tagOf,
} from "@/lib/api-tokens";
import type { D1Like } from "@/lib/d1/types";
import { type AuditDb, audit } from "@/lib/security/audit-log";
import { sha256Hex } from "@/lib/security/throttle";
import { laneOf } from "../packages/debug-chat/src/voices";
import { CHILD_SEP, CHILD_SUB_MAX } from "../packages/debug-chat/src/child-lane";

export { CHILD_SEP, CHILD_SUB_MAX };

/** Names no subagent may take: they read as the owner or the system. */
const RESERVED = /^(owner|admin|system|root|li|lianki|站长|主人|我|系统)$/iu;

export type ChildLimits = { defaultMinutes: number; maxMinutes: number; maxLive: number };
/** The registry defaults (lib/config.ts tokens.child*): the live values come from the DB. */
export const CHILD_DEFAULTS: ChildLimits = { defaultMinutes: 240, maxMinutes: 1440, maxLive: 8 };
/** The shortest child: five minutes. */
export const CHILD_MIN_MINUTES = 5;
/** What a child gets when it names no permissions: the parent's chat read and write. */
export const CHILD_DEFAULT_SCOPES: readonly ScopeId[] = ["chat:read", "chat:write"];

/**
 * A subagent's own name: a token name (one line, no 【】, no control
 * characters), at most CHILD_SUB_MAX characters, no `·`, and not a lane's
 * name or alias (voices.ts) or one that reads as the owner. Else null.
 */
export function cleanChildName(raw: unknown): string | null {
  // 【】 is refused, not stripped: a name with it is trying to be a line's prefix.
  if (typeof raw !== "string" || /[【】]/u.test(raw)) return null;
  const s = cleanTokenName(raw);
  if (!s || [...s].length > CHILD_SUB_MAX || s.includes(CHILD_SEP)) return null;
  if (RESERVED.test(s)) return null;
  if (laneOf({ text: `【${s}】` }).lane) return null;
  return s;
}

export type ChildRefusal = { ok: false; status: number; error: string };
export type ChildMinted = {
  ok: true;
  token: string;
  id: string;
  name: string;
  scopes: ScopeId[];
  expiresAt: string;
};

type Parent = {
  id: string;
  name: string;
  userId: string;
  email: string;
  scopes: ScopeId[];
  expiresAt: string | null;
};

const refuse = (status: number, error: string): ChildRefusal => ({ ok: false, status, error });

/** The live children of `parentId`, newest first. */
export async function listChildren(db: D1Like, parentId: string, now: number) {
  const { results } = await db
    .prepare(
      `SELECT token_hash, name, scopes, created_at, expires_at, last_used_at FROM api_tokens
       WHERE parent_hash = ? ORDER BY created_at DESC`,
    )
    .bind(parentId)
    .all<{
      token_hash: string;
      name: string;
      scopes: string | null;
      created_at: string;
      expires_at: string | null;
      last_used_at: string | null;
    }>();
  return results
    .filter((r) => !isExpired(r.expires_at, now))
    .map((r) => ({
      id: r.token_hash,
      name: r.name,
      scopes: rowScopes(r.scopes),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
    }));
}

/** Mint one child of `parent` (already checked: live, holding MINT_CHILD, its account `dev`). */
export async function mintChild(
  db: D1Like & AuditDb,
  parent: Parent,
  body: Record<string, unknown>,
  limits: ChildLimits,
  now: number,
): Promise<ChildMinted | ChildRefusal> {
  const sub = cleanChildName(body.name);
  if (!sub)
    return refuse(
      400,
      `name: 1–${CHILD_SUB_MAX} characters, no 【】 or ${CHILD_SEP}, not a lane's or the owner's name`,
    );
  const name = `${parent.name}${CHILD_SEP}${sub}`;
  if ([...name].length > MAX_NAME) return refuse(400, `name: the full name is over ${MAX_NAME}`);

  const asked = body.scopes ?? CHILD_DEFAULT_SCOPES.filter((s) => parent.scopes.includes(s));
  if (Array.isArray(asked) && asked.includes(MINT_CHILD))
    return refuse(400, "scopes: a child token cannot mint children");
  const scopes = parseScopes(asked, { owner: true });
  if (!scopes) return refuse(400, "scopes: pick at least one permission");
  const extra = scopes.filter((s) => !parent.scopes.includes(s));
  if (extra.length) return refuse(400, `scopes: not held by the parent: ${extra.join(" ")}`);

  if (parent.expiresAt === null) return refuse(400, "expiry: the parent has no expiry");
  const parentEnd = Date.parse(parent.expiresAt);
  let end: number;
  if (body.ttlMinutes === undefined) {
    // The default never passes the max: both are live config values.
    const minutes = Math.min(limits.defaultMinutes, limits.maxMinutes);
    end = Math.min(now + minutes * 60_000, parentEnd);
  } else {
    const m = body.ttlMinutes;
    if (
      typeof m !== "number" ||
      !Number.isInteger(m) ||
      m < CHILD_MIN_MINUTES ||
      m > limits.maxMinutes
    )
      return refuse(400, `ttlMinutes: ${CHILD_MIN_MINUTES}–${limits.maxMinutes}`);
    end = now + m * 60_000;
    if (end > parentEnd) return refuse(400, "expiry: past the parent's expiry");
  }
  if (end < now + CHILD_MIN_MINUTES * 60_000)
    return refuse(400, "expiry: the parent expires too soon");

  const token = newSecret();
  const id = await sha256Hex(token);
  const expiresAt = new Date(end).toISOString();
  const nowIso = new Date(now).toISOString();
  // The cap and the unique live name are checked inside the INSERT itself: one
  // statement, so two mints at once (in any isolate) cannot both pass a check
  // made before either wrote. A child's expires_at is always toISOString(), so
  // the text comparison orders like time.
  const inserted = await db
    .prepare(
      `INSERT INTO api_tokens (token_hash, email, name, created_at, user_id, scopes, expires_at, parent_hash)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT count(*) FROM api_tokens
               WHERE parent_hash = ? AND (expires_at IS NULL OR expires_at > ?)) < ?
         AND NOT EXISTS (SELECT 1 FROM api_tokens
               WHERE parent_hash = ? AND name = ? AND (expires_at IS NULL OR expires_at > ?))
       RETURNING token_hash`,
    )
    .bind(
      id,
      parent.email,
      name,
      nowIso,
      parent.userId,
      JSON.stringify(scopes),
      expiresAt,
      parent.id,
      parent.id,
      nowIso,
      limits.maxLive,
      parent.id,
      name,
      nowIso,
    )
    .first<{ token_hash: string }>();
  if (!inserted) {
    // Nothing written: say which rule held it back.
    const live = await listChildren(db, parent.id, now);
    if (live.length < limits.maxLive && live.some((c) => c.name === name))
      return refuse(409, "name: a live child has it");
    return refuse(409, `Too many child tokens (${limits.maxLive}): revoke one first`);
  }
  await audit(
    db,
    {
      kind: "api-token.child-mint",
      actor: parent.userId,
      subject: tagOf(id),
      detail: `${name} [${scopes.join(" ")}] until ${expiresAt} by ${tagOf(parent.id)}`,
    },
    now,
  );
  return { ok: true, token, id, name, scopes, expiresAt };
}

/** Revoke one child of `parent` by id; anything else is "not found". */
export async function revokeChild(
  db: D1Like & AuditDb,
  parent: Pick<Parent, "id" | "userId">,
  id: unknown,
  now: number,
  why = "by parent",
): Promise<{ id: string; name: string } | null> {
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) return null;
  const r = await db
    .prepare(
      "DELETE FROM api_tokens WHERE token_hash = ? AND parent_hash = ? RETURNING token_hash, name, scopes",
    )
    .bind(id, parent.id)
    .first<{ token_hash: string; name: string; scopes: string | null }>();
  if (!r) return null;
  await auditChildRevoke(db, parent.userId, r, why, now);
  return { id: r.token_hash, name: r.name };
}

/** One audit row per revoked child (by its parent, the owner, or with its parent). */
export async function auditChildRevoke(
  db: AuditDb,
  actor: string,
  r: { token_hash?: string; id?: string; name: string; scopes?: string | null | ScopeId[] },
  why: string,
  now = Date.now(),
) {
  const id = r.token_hash ?? r.id ?? "";
  const scopes = Array.isArray(r.scopes) ? r.scopes : rowScopes(r.scopes ?? null);
  await audit(
    db,
    {
      kind: "api-token.child-revoke",
      actor,
      subject: tagOf(id),
      detail: `${r.name} [${scopes.join(" ")}] ${why}`,
    },
    now,
  );
}

export type ChildApiDeps = {
  db: () => D1Like & AuditDb;
  /** The flag `tokens.child`, read now. Off: the route does not exist. */
  enabled: () => Promise<boolean>;
  /** Does this account hold `dev` now? Only then may its token mint children. */
  siteOwner: (userId: string) => Promise<boolean>;
  /** The live limits (lib/config.ts tokens.child*). */
  limits: () => Promise<ChildLimits>;
  /** Revoked tokens' listening sockets close (lib/push-chat-tokens.ts). */
  revoked: (ids: string[]) => Promise<void>;
  now?: () => number;
};

const NO_STORE = { "cache-control": "private, no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** /api/token/child: a bearer token's own children. Never a browser session. */
export async function childApi(req: Request, deps: ChildApiDeps): Promise<Response> {
  if (!(await deps.enabled())) return json({ error: "Not found" }, 404);
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE")
    return json({ error: "Method" }, 405);
  const m = /^Bearer (lk_[0-9a-f]{64})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return json({ error: "unknown" }, 401);
  const now = (deps.now ?? Date.now)();
  const db = deps.db();
  const c = await checkToken(db, m[1], MINT_CHILD, now);
  if (!c.ok) {
    if (c.reason === "scope") return json({ error: "scope", needScope: MINT_CHILD }, 403);
    return json({ error: c.reason === "expired" ? "expired" : "unknown" }, 401);
  }
  // Made by hand, not a child, not an OAuth app's: only such a token is a parent.
  const row = await db
    .prepare("SELECT parent_hash, oauth_grant_id FROM api_tokens WHERE token_hash = ?")
    .bind(c.id)
    .first<{ parent_hash: string | null; oauth_grant_id: string | null }>();
  if (!row || row.parent_hash || row.oauth_grant_id) return json({ error: "scope" }, 403);
  if (!(await deps.siteOwner(c.user.id).catch(() => false))) return json({ error: "scope" }, 403);
  const parent: Parent = {
    id: c.id,
    name: c.name,
    userId: c.user.id,
    email: c.user.email,
    scopes: c.scopes,
    expiresAt: c.expiresAt,
  };

  if (req.method === "GET") return json({ children: await listChildren(db, c.id, now) });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return json({ error: "Expected JSON" }, 400);

  if (req.method === "DELETE") {
    const gone = await revokeChild(db, parent, body.id, now);
    if (!gone) return json({ error: "Not found" }, 404);
    await deps.revoked([gone.id]);
    return json({ ok: true });
  }

  const out = await mintChild(db, parent, body, await deps.limits(), now);
  if (!out.ok) return json({ error: out.error }, out.status);
  const { ok: _ok, ...minted } = out;
  // The secret, this once, to the caller only.
  return json({ ...minted, parent: tagOf(c.id) });
}
