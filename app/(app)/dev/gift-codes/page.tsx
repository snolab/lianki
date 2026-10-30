import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { GiftCodesClient } from "./GiftCodesClient";

// Owner-only, like /dev/roadmap: everyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gift codes — Lianki",
  robots: { index: false, follow: false, nocache: true },
};

export default async function GiftCodesPage() {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
  return (
    <main lang="zh" className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="font-brush text-4xl">礼品码</h1>
        <p className="text-sm opacity-60">
          只有你能看到这页。生成「N 天 Pro 和/或 ¥X 余额，可用 M 次」的码；朋友在 /membership
          页底部兑换，每人每个码只能用一次。不占邀请奖励的年度上限。
        </p>
      </header>
      <GiftCodesClient />
    </main>
  );
}
