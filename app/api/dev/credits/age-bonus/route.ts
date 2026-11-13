import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import { dbBackend, getD1 } from "@/lib/d1";
import { handleAgeBonus } from "@/lib/payments/age-bonus-api";
import type { D1WithBatch } from "@/lib/payments/credits-store";

/** The account-age bonus backfill: lib/payments/age-bonus-api.ts. Admin only, 404 otherwise. */
export const POST = (req: Request) =>
  handleAgeBonus(req, {
    admin: async () => {
      const user = await authUserOrNull();
      return isAdmin(user?.email) ? (user?.email ?? null) : null;
    },
    db: () => (dbBackend() === "d1" ? (getD1() as unknown as D1WithBatch) : null),
  });
