import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { PERMISSION_CACHE_MS, isAdmin, normalizeEmail } from "@/lib/permissions";
import PermissionsAdmin from "./PermissionsAdmin";
import PermissionsHeader from "./PermissionsHeader";

// Admin-only: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Permissions — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/**
 * Who holds `admin` and `dev`: the account_permission table
 * (lib/account-permission.ts, docs/secrets-and-auth.md, "Permissions").
 */
export default async function DevPermissionsPage() {
  const user = await authUserOrNull();
  if (!isAdmin(user?.email)) notFound();
  const seconds = PERMISSION_CACHE_MS / 1000;
  return (
    <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <PermissionsHeader seconds={seconds} />
      <PermissionsAdmin self={normalizeEmail(user?.email)} seconds={seconds} />
    </main>
  );
}
