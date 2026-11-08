import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { dbBackend, getD1 } from "@/lib/d1";
import { type AnchorRow, listAnchors } from "@/lib/lian/anchor";
import { LianVerify } from "./LianVerify";

// Owner-only: the study ledger's anchors (docs/lian.md), with the chain and
// the owner's own leaves checked in the browser by packages/lian — the same
// code anyone can run against /api/lian/anchors. Anyone else: a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Study ledger — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

export default async function DevLianPage() {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) notFound();
  let anchors: AnchorRow[] = [];
  let stamps: Record<string, string> = {};
  let error: string | null = null;
  if (dbBackend() === "d1")
    try {
      const d1 = getD1();
      anchors = (await listAnchors(d1, { limit: 1000 })).reverse();
      const { results } = await d1
        .prepare("SELECT day, status, btc_height FROM lian_timestamp")
        .all<{ day: string; status: string; btc_height: number | null }>();
      stamps = Object.fromEntries(
        results.map((r) => [r.day, r.btc_height ? `bitcoin #${r.btc_height}` : r.status]),
      );
    } catch (e) {
      error = (e as Error).message;
    }
  return (
    <main className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <h1 className="text-2xl font-semibold">Study ledger</h1>
      <p className="text-sm opacity-70">
        One anchor per day: the Merkle root of that day&apos;s salted study-day leaves, chained to
        the day before. Written by the daily cron; checked here in your browser.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {dbBackend() !== "d1" && <p className="text-sm opacity-70">D1 only.</p>}
      <LianVerify anchors={anchors} stamps={stamps} />
    </main>
  );
}
