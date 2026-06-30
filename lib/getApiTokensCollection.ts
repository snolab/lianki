import { createHash } from "crypto";
import { db } from "@/app/db";
// ApiToken moved to lib/core/apiToken.ts (MongoDB-free) for reuse by the D1
// repos / CF-native worker; re-exported here so existing imports keep working.
import type { ApiToken } from "@/lib/core/apiToken";
export type { ApiToken };

export function getApiTokensCollection() {
  return db.collection<ApiToken>("ApiTokens");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function getEmailByToken(token: string): Promise<string | null> {
  const col = getApiTokensCollection();
  const doc = await col.findOne({ tokenHash: hashToken(token) });
  return doc?.email ?? null;
}
