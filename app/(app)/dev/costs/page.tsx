import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import { devPageMetadata, devPageText } from "../dev-page-title";
import CostsAdmin from "./CostsAdmin";

// Admin only, like /dev/credits: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("costs", { referrer: "no-referrer" });

/**
 * The cost ledger (docs/payments.md, "Cost ledger"): what each account's calls
 * cost us, free and paid side by side. lib/payments/cost-ledger.ts through
 * /api/dev/costs.
 */
export default async function DevCostsPage() {
  const user = await authUserOrNull();
  if (!isAdmin(user?.email)) notFound();
  const heading = await devPageText("costs");
  return (
    <main className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <h1 lang={heading.lang} className="font-brush text-4xl">
        {heading.text}
      </h1>
      <CostsAdmin />
    </main>
  );
}
