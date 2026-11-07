/**
 * `lianki chat` (packages/lianki-cli): is this API token allowed this chat
 * operation, and as whom? Asked by lianki-push's DebugHub before every say,
 * ask and read, and when a listen socket opens (debug.ts, "Token chat";
 * docs/lianki-dev-cli.md). Not an HTTP route: the main Worker exports it as
 * DebugSessions.chatToken (worker.ts), reachable only over lianki-push's
 * SESSIONS service binding.
 *
 * Deny by default. The answer names exactly one thread, the token account's
 * own: the owner's thread for an owner account, else that user's Learning
 * Partner thread. The hub posts and reads there and nowhere else; nothing in
 * the request can name another thread. The token needs the operation's
 * permission (lib/api-tokens.ts SCOPES); eval, pairing, grants and answers
 * are not operations here at all.
 *
 * Per token, in D1 (so isolates cannot be walked around): CHAT_LIMITS. Each
 * use is in the security audit log when last_used_at is written (at most once
 * a minute per token); a refused known token (expired, out of scope, over its
 * limit) at most REFUSED_AUDITS per window. Never the token, only its tag.
 */
import { type ScopeId, checkToken, tagOf } from "@/lib/api-tokens";
import type { D1Like } from "@/lib/d1/types";
import { normalizeEmail } from "@/lib/owner";
import { type AuditDb, audit } from "@/lib/security/audit-log";
import { hit, type Limit, type ThrottleDb } from "@/lib/security/throttle";
import { readOwnerEmails, type OwnerReadDb } from "@/lib/site-role";

const MIN = 60_000;

/** What each operation needs. `recheck` is the hub re-checking a listening socket's token. */
export const CHAT_OPS = {
  say: "chat:write",
  ask: "chat:ask",
  read: "chat:read",
  listen: "chat:read",
  recheck: "chat:read",
} as const satisfies Record<string, ScopeId>;
export type ChatOp = keyof typeof CHAT_OPS;

/** Per token, per kind of operation. */
export const CHAT_LIMITS: Record<"post" | "read" | "listen", Limit> = {
  post: { max: 60, windowMs: 10 * MIN }, // say + ask
  read: { max: 240, windowMs: 10 * MIN },
  listen: { max: 30, windowMs: 10 * MIN },
};
const limitOf = (op: ChatOp) =>
  op === "say" || op === "ask"
    ? "post"
    : op === "read"
      ? "read"
      : op === "listen"
        ? "listen"
        : null;
const REFUSED_AUDITS: Limit = { max: 5, windowMs: 10 * MIN };

export type ChatTokenRequest = { op: ChatOp; token?: string; tokenHash?: string };

export type ChatTokenAnswer =
  | {
      ok: true;
      userId: string;
      /** The owner's account: its thread is the owner thread. */
      owner: boolean;
      /** The token's name: the lane, on every line it posts. */
      lane: string;
      /** The token's public id (its SHA-256), and its short tag. */
      id: string;
      tag: string;
      /** When the token stops working (ms); null on a token from before expiry dates. */
      expiresAt: number | null;
      name?: string;
      image?: string;
    }
  | {
      ok: false;
      error: "bad request" | "unknown" | "expired" | "scope" | "rate";
      retryAfterMs?: number;
    };

export type ChatTokenDb = D1Like & ThrottleDb & AuditDb & OwnerReadDb;

export async function chatTokenCheck(
  db: ChatTokenDb,
  raw: unknown,
  now = Date.now(),
): Promise<ChatTokenAnswer> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const op = r.op as ChatOp;
  if (typeof op !== "string" || !Object.hasOwn(CHAT_OPS, op))
    return { ok: false, error: "bad request" };
  // The hub names a token by its secret (an HTTP call, a listen socket's first
  // message) or, once it has checked that, by its hash: a listening socket
  // keeps only the hash. Exactly one of the two.
  const byHash = r.tokenHash !== undefined;
  const cred = byHash ? r.tokenHash : r.token;
  if (typeof cred !== "string" || (byHash && r.token !== undefined))
    return { ok: false, error: "bad request" };
  const c = await checkToken(db, cred, CHAT_OPS[op], now, { byHash });
  if (!c.ok) {
    if (c.reason === "malformed") return { ok: false, error: "bad request" };
    if (c.id && c.userId) await refused(db, c.userId, c.id, `${op} ${c.reason}`, now);
    return { ok: false, error: c.reason === "unknown" ? "unknown" : c.reason };
  }
  const kind = limitOf(op);
  if (kind) {
    const l = await hit(db, `chat-token:${tagOf(c.id)}:${kind}`, CHAT_LIMITS[kind], now);
    if (!l.allowed) {
      await refused(db, c.user.id, c.id, `${op} rate`, now);
      return { ok: false, error: "rate", retryAfterMs: l.retryAfterMs };
    }
  }
  if (c.touched)
    await audit(
      db,
      {
        kind: "api-token.use",
        actor: c.user.id,
        subject: tagOf(c.id),
        detail: `chat ${op} ${c.name}`,
      },
      now,
    );
  // Straight from site_role: a D1 error throws, and the hub refuses.
  const owners = await readOwnerEmails(db);
  const expires = c.expiresAt ? Date.parse(c.expiresAt) : null;
  return {
    ok: true,
    userId: c.user.id,
    owner: owners.includes(normalizeEmail(c.user.email)),
    lane: c.name,
    id: c.id,
    tag: tagOf(c.id),
    expiresAt: expires !== null && Number.isFinite(expires) ? expires : null,
    ...(c.user.name ? { name: c.user.name } : {}),
    ...(c.user.image ? { image: c.user.image } : {}),
  };
}

async function refused(db: ChatTokenDb, userId: string, id: string, detail: string, now: number) {
  const l = await hit(db, `chat-token-refused:${tagOf(id)}`, REFUSED_AUDITS, now);
  if (l.allowed)
    await audit(db, { kind: "api-token.refused", actor: userId, subject: tagOf(id), detail }, now);
}
