import { headers } from "next/headers";
import { auth } from "@/auth";
import { dbBackend, getD1 } from "@/lib/d1";
import { creditUsage } from "@/lib/payments/credit-usage-handler";

/**
 * GET /api/payments/credits/usage — the signed-in user's own credits usage
 * (lib/payments/credit-usage.ts): `?tz&group&from&to&offset&limit`, or
 * `&format=csv` for the export. 401 signed out, 503 off D1.
 */
export async function GET(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  return creditUsage(req, {
    userId: session?.user?.id ?? null,
    d1: dbBackend() === "d1" ? getD1() : null,
  });
}
