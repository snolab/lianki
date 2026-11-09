import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import { GiftCodesClient } from "./GiftCodesClient";
import { devPageText, devPageMetadata } from "../dev-page-title";

// Owner-only, like /dev/roadmap: everyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("giftCodes");

export default async function GiftCodesPage() {
  const user = await authUserOrNull();
  if (!isAdmin(user?.email)) notFound();
  const heading = await devPageText("giftCodes");
  return (
    <main lang="zh" className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 lang={heading.lang} className="font-brush text-4xl">
          {heading.text}
        </h1>
        <p className="text-sm opacity-60">
          只有你能看到这页。生成「N 天 Pro 和/或 X 积分余额，可用 M 次」的码；朋友在 /membership
          页底部兑换，每人每个码只能用一次。不占邀请奖励的年度上限。
        </p>
      </header>
      <GiftCodesClient />
    </main>
  );
}
