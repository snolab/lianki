import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { dbBackend } from "@/lib/d1";
import { loadRealData, type RealData } from "./real";
import { NewOrderSim } from "./NewOrderSim";
import { devPageMetadata } from "../dev-page-title";

// Owner-only, like /dev/roadmap: anyone else gets a plain 404. Reads only;
// the real study order does not use any of this yet.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("newOrder");

export default async function DevNewOrderPage() {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) notFound();
  let real: RealData | null = null;
  let realError: string | null = null;
  if (dbBackend() === "d1")
    try {
      real = await loadRealData(user!.email!);
    } catch (e) {
      realError = (e as Error).message;
    }
  return (
    <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <NewOrderSim real={real} realError={realError} />
    </main>
  );
}
