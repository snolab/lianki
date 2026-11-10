import { createHash } from "crypto";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { checkToken } from "@/lib/api-tokens";
import { auditClientUse } from "@/lib/api-token-client";
import type { AuditDb } from "@/lib/security/audit-log";

/**
 * Bearer API-token lookup, following DB_BACKEND like every other data route.
 *
 * MongoDB-free on purpose: on production (DB_BACKEND=d1) MongoDB is a frozen
 * rollback copy, so a token must be checked against D1 only. Falling back to
 * Mongo would let a token revoked in D1 keep working. The Mongo path is loaded
 * lazily so the D1 path never touches app/db.ts.
 */

/** SHA-256 hex of the plain token: the only form ever stored or compared. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type TokenLookupDeps = {
  backend: () => "mongodb" | "d1";
  d1: () => D1Like;
  /** email by token hash from MongoDB; used only when the backend is mongodb */
  mongoEmailByHash: (tokenHash: string) => Promise<string | null>;
};

const defaultDeps: TokenLookupDeps = {
  backend: () => dbBackend(),
  d1: () => getD1() as unknown as D1Like,
  mongoEmailByHash: async (tokenHash) => {
    const { getApiTokensCollection } = await import("@/lib/getApiTokensCollection");
    const doc = await getApiTokensCollection().findOne({ tokenHash });
    return doc?.email ?? null;
  },
};

/**
 * The email owning this plain API token, or null when unknown, revoked,
 * expired, its account gone, or without the `study` permission (a chat-only
 * lane token reaches no card or settings route; lib/api-tokens.ts).
 * `client` (lib/api-token-client.ts, e.g. "mcp/0.4.0 lianki_due") puts the
 * use in the audit log; without it nothing is logged here.
 */
export async function getEmailByToken(
  token: string,
  deps: TokenLookupDeps = defaultDeps,
  client: string | null = null,
): Promise<string | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  if (deps.backend() === "d1") {
    const db = deps.d1();
    const r = await checkToken(db, token, "study");
    await auditClientUse(db as unknown as AuditDb, r, client, "study");
    return r.ok ? r.user.email : null;
  }
  return deps.mongoEmailByHash(tokenHash);
}
