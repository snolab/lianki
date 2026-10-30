import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import CreditsAdmin from "./CreditsAdmin";

// Owner-only, like /dev/membership: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Credits — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

export default async function DevCreditsPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
  return (
    <main lang="zh" className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <h1 className="font-brush text-4xl">余额</h1>
      <p className="text-sm opacity-70">
        查任意账号的余额和流水，手动加减（赞助 sponsor / 调整 adjust / 赠送 gift），
        余额永远不会变成负数。流水里的「用余额买的通行证」可以退回余额（同时扣回天数），
        在支付商那边退了款的充值可以撤回。每次操作都记日志。
      </p>
      <CreditsAdmin defaultEmail={(await searchParams).email ?? user!.email!} />
    </main>
  );
}
