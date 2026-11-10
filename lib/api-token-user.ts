import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import type { BridgeUser } from "@/lib/dev-bridge-user";
import { checkToken } from "@/lib/api-tokens";
import { CLIENT_HEADER, auditClientUse, clientOf } from "@/lib/api-token-client";
import type { AuditDb } from "@/lib/security/audit-log";

/**
 * Who an `Authorization: Bearer lk_…` request is, for /api/prefs ONLY (the
 * `lianki settings` CLI, docs/secrets-and-auth.md "CLI login"). Every other
 * route keeps its own auth; unit/cli-login.test.ts fails if another route
 * imports this.
 *
 * - `undefined`: no Authorization header — the route uses the session.
 * - `null`: a header that is not a known lk_ token — refuse; never fall back
 *   to the cookie.
 * - the token's user (better-auth's `user` row for the token's email).
 *
 * D1 only: on the frozen Mongo rollback copy every token is refused. The
 * token needs the `study` permission, unexpired, and its account's live row
 * (lib/api-tokens.ts checkToken).
 */
export async function apiTokenUser(req: Request): Promise<BridgeUser | null | undefined> {
  const h = req.headers.get("Authorization");
  if (h === null) return undefined;
  const m = /^Bearer (lk_[0-9a-f]{64})$/.exec(h);
  if (!m || dbBackend() !== "d1") return null;
  const db = getD1() as unknown as D1Like;
  const r = await checkToken(db, m[1], "study");
  // A named client (`lianki mcp`): the use goes in the audit log (lib/api-token-client.ts).
  const client = clientOf(req.headers.get(CLIENT_HEADER));
  await auditClientUse(db as unknown as AuditDb, r, client, `settings ${req.method}`);
  return r.ok
    ? { id: r.user.id, email: r.user.email, name: r.user.name, image: r.user.image }
    : null;
}
