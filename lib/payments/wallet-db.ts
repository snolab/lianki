/**
 * The credit wallet's database for a route that pays a provider call
 * (lib/payments/metered.ts): D1 in production; null on the frozen Mongo
 * backend (local dev), where nothing can be charged and the call runs unmetered.
 * Only the wallet's tables are written through it.
 */
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1WithBatch } from "./credits-store";

export const walletDb = (): D1WithBatch | null =>
  dbBackend() === "d1" ? (getD1() as unknown as D1WithBatch) : null;

/** The wallet's owner for a route that knows only the email (an API token): their user id, or "". */
export async function walletUserId(db: D1WithBatch | null, email: string): Promise<string> {
  if (!db) return "";
  const row = await db
    .prepare("SELECT id FROM user WHERE email = ?1 COLLATE NOCASE")
    .bind(email)
    .first<{ id: string }>();
  return row?.id ?? "";
}
