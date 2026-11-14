import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import CreditsAdmin from "./CreditsAdmin";
import { devPageText, devPageMetadata } from "../dev-page-title";

// Owner-only, like /dev/membership: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("credits");

export default async function DevCreditsPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const user = await authUserOrNull();
  if (!isAdmin(user?.email)) notFound();
  const heading = await devPageText("credits");
  return (
    <main lang="zh" className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <h1 lang={heading.lang} className="font-brush text-4xl">
        {heading.text}
      </h1>
      <p className="text-sm opacity-70">
        查任意账号的余额和流水，手动加减（赞助 sponsor / 调整 adjust / 赠送 gift），
        余额永远不会变成负数。流水里的「用余额买的通行证」可以退回余额（同时扣回天数），
        在支付商那边退了款的充值可以撤回。每次操作都记日志。
      </p>
      <CreditsAdmin defaultEmail={(await searchParams).email ?? user!.email!} />
    </main>
  );
}
