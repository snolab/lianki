import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import type { BridgeUser } from "@/lib/dev-bridge-user";
import { sha256Hex } from "@/lib/security/throttle";

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
 * D1 only: on the frozen Mongo rollback copy every token is refused.
 */
export async function apiTokenUser(req: Request): Promise<BridgeUser | null | undefined> {
  const h = req.headers.get("Authorization");
  if (h === null) return undefined;
  const m = /^Bearer (lk_[0-9a-f]{64})$/.exec(h);
  if (!m || dbBackend() !== "d1") return null;
  const db = getD1() as unknown as D1Like;
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.image FROM api_tokens t
       JOIN user u ON u.email = t.email WHERE t.token_hash = ?`,
    )
    .bind(await sha256Hex(m[1]))
    .first<BridgeUser>();
  return row ?? null;
}
