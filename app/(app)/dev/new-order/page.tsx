import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend } from "@/lib/d1";
import { loadRealData, type RealData } from "./real";
import { NewOrderSim } from "./NewOrderSim";

// Owner-only, like /dev/roadmap: anyone else gets a plain 404. Reads only;
// the real study order does not use any of this yet.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "New-word order — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

export default async function DevNewOrderPage() {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
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
