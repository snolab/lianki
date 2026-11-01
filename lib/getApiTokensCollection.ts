import { db } from "@/app/db";
// ApiToken moved to lib/core/apiToken.ts (MongoDB-free) for reuse by the D1
// repos / CF-native worker; re-exported here so existing imports keep working.
import type { ApiToken } from "@/lib/core/apiToken";
export type { ApiToken };
// Token lookup follows DB_BACKEND and lives in the MongoDB-free lib/apiTokenAuth.ts.
export { hashToken, getEmailByToken } from "@/lib/apiTokenAuth";

/** MongoDB only — the rollback copy. Callers must branch on dbBackend() first. */
export function getApiTokensCollection() {
  return db.collection<ApiToken>("ApiTokens");
}
