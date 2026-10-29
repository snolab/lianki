import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import GrantPro from "./GrantPro";

// Owner-only, like /dev/roadmap: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Membership — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

export default async function DevMembershipPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
  return (
    <main lang="zh" className="max-w-xl mx-auto px-4 py-8 space-y-6">
      <h1 className="font-brush text-4xl">会员</h1>
      <p className="text-sm opacity-70">
        给任意账号加 Pro 天数：从「现在」和「当前 Pro
        到期日」两者较晚的那个开始往后加。每次发放都记日志。
      </p>
      <GrantPro defaultEmail={(await searchParams).email ?? user!.email!} />
    </main>
  );
}
