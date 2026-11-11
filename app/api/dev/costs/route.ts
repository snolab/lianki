import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { costsGet } from "@/lib/payments/costs-route";
import { isAdmin } from "@/lib/permissions";

/**
 * The cost ledger for /dev/costs (lib/payments/costs-route.ts; docs/payments.md,
 * "Cost ledger"). Admin only, 404 for anyone else.
 */
export async function GET(req: Request) {
  const u = await authUserOrNull();
  return costsGet(req, isAdmin(u?.email), dbBackend() === "d1" ? getD1() : null);
}
