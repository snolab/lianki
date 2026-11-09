import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import GrantPro from "./GrantPro";
import { devPageText, devPageMetadata } from "../dev-page-title";

// Owner-only, like /dev/roadmap: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("membership");

export default async function DevMembershipPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const user = await authUserOrNull();
  if (!isAdmin(user?.email)) notFound();
  const heading = await devPageText("membership");
  return (
    <main lang="zh" className="max-w-xl mx-auto px-4 py-8 space-y-6">
      <h1 lang={heading.lang} className="font-brush text-4xl">
        {heading.text}
      </h1>
      <p className="text-sm opacity-70">
        给任意账号加 Pro 天数：从「现在」和「当前 Pro
        到期日」两者较晚的那个开始往后加。每次发放都记日志。
      </p>
      <GrantPro defaultEmail={(await searchParams).email ?? user!.email!} />
    </main>
  );
}
