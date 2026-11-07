/**
 * Eval tokens (docs/secrets-and-auth.md, "Eval tokens"): an API token with the
 * `eval` permission runs code on the site owner's open pages (eval.ts and
 * lianki-dev with LIANKI_TOKEN), with no pairing tap. Creating the token is
 * the grant (owner's decision by tap card, 2026-11-07).
 *
 * Asked by lianki-push's DebugHub when a sender connects with one, and again
 * before every eval it sends. Not an HTTP route: the main Worker exports it as
 * DebugSessions.evalToken (worker.ts), reachable only over the SESSIONS
 * service binding.
 *
 * Deny by default. The token must be live, hold `eval`, and its account be a
 * site owner right now (site_role, no cache). Every use is in security_audit
 * (`api-token.eval`: connect, or one eval), never the token, only its tag;
 * a refused known token at most REFUSED_AUDITS per window. Per token in D1:
 * EVAL_LIMIT uses per window.
 */
import { checkToken, tagOf } from "@/lib/api-tokens";
import type { D1Like } from "@/lib/d1/types";
import { normalizeEmail } from "@/lib/owner";
import { type AuditDb, audit } from "@/lib/security/audit-log";
import { hit, type Limit, type ThrottleDb } from "@/lib/security/throttle";
import { readOwnerEmails, type OwnerReadDb } from "@/lib/site-role";

const MIN = 60_000;
/** Connects and evals per token: a lane's burst of commands, never a loop. */
export const EVAL_LIMIT: Limit = { max: 300, windowMs: 10 * MIN };
const REFUSED_AUDITS: Limit = { max: 5, windowMs: 10 * MIN };

export type EvalTokenRequest = {
  /** "connect": a sender opens with the token; "use": one eval it sends. */
  op: "connect" | "use";
  /** The secret on connect; the hub keeps only the hash after that. Exactly one. */
  token?: string;
  tokenHash?: string;
  /** "use" only: what the eval was, for the audit line (its length and target). */
  len?: number;
  target?: string;
};

export type EvalTokenAnswer =
  | {
      ok: true;
      /** The token's public id (its SHA-256), and its short tag. */
      id: string;
      tag: string;
      /** The token's account (the owner's user id): a sign-out everywhere closes its senders. */
      userId: string;
      /** The token's name: the sender's label. */
      name: string;
      /** When the token stops working (ms). */
      expiresAt: number;
    }
  | {
      ok: false;
      error: "bad request" | "unknown" | "expired" | "scope" | "not-owner" | "rate";
      retryAfterMs?: number;
    };

export type EvalTokenDb = D1Like & ThrottleDb & AuditDb & OwnerReadDb;

export async function evalTokenCheck(
  db: EvalTokenDb,
  raw: unknown,
  now = Date.now(),
): Promise<EvalTokenAnswer> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const op = r.op;
  if (op !== "connect" && op !== "use") return { ok: false, error: "bad request" };
  // A connect names the secret; a use names the hash the connect returned.
  const byHash = op === "use";
  const cred = byHash ? r.tokenHash : r.token;
  if (typeof cred !== "string" || (byHash ? r.token : r.tokenHash) !== undefined)
    return { ok: false, error: "bad request" };
  const c = await checkToken(db, cred, "eval", now, { byHash });
  if (!c.ok) {
    if (c.reason === "malformed") return { ok: false, error: "bad request" };
    if (c.id && c.userId) await refused(db, c.userId, c.id, `eval ${op} ${c.reason}`, now);
    return { ok: false, error: c.reason === "unknown" ? "unknown" : c.reason };
  }
  // A token from before expiry dates has none: eval needs one, always.
  const expires = c.expiresAt ? Date.parse(c.expiresAt) : NaN;
  if (!Number.isFinite(expires)) {
    await refused(db, c.user.id, c.id, `eval ${op} no-expiry`, now);
    return { ok: false, error: "expired" };
  }
  // Straight from site_role: a D1 error throws, and the hub refuses.
  const owners = await readOwnerEmails(db);
  if (!owners.includes(normalizeEmail(c.user.email))) {
    await refused(db, c.user.id, c.id, `eval ${op} not-owner`, now);
    return { ok: false, error: "not-owner" };
  }
  const l = await hit(db, `eval-token:${tagOf(c.id)}`, EVAL_LIMIT, now);
  if (!l.allowed) {
    await refused(db, c.user.id, c.id, `eval ${op} rate`, now);
    return { ok: false, error: "rate", retryAfterMs: l.retryAfterMs };
  }
  // Every use, not once a minute: running code on his pages is never routine.
  const len = typeof r.len === "number" && Number.isFinite(r.len) ? Math.trunc(r.len) : undefined;
  const target = typeof r.target === "string" ? r.target.slice(0, 80) : undefined;
  await audit(
    db,
    {
      kind: "api-token.eval",
      actor: c.user.id,
      subject: tagOf(c.id),
      detail: [
        op === "connect" ? "connect" : "eval",
        c.name,
        ...(len !== undefined ? [`len ${len}`] : []),
        ...(target ? [`target ${target}`] : []),
      ].join(" "),
    },
    now,
  );
  return {
    ok: true,
    id: c.id,
    tag: tagOf(c.id),
    userId: c.user.id,
    name: c.name,
    expiresAt: expires,
  };
}

async function refused(db: EvalTokenDb, userId: string, id: string, detail: string, now: number) {
  const l = await hit(db, `eval-token-refused:${tagOf(id)}`, REFUSED_AUDITS, now);
  if (l.allowed)
    await audit(db, { kind: "api-token.refused", actor: userId, subject: tagOf(id), detail }, now);
}
