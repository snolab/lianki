import { createHash } from "crypto";
import { db } from "@/app/db";

export type ApiToken = {
  tokenHash: string;
  email: string;
  name: string;
  createdAt: Date;
};

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
