import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner, normalizeEmail } from "@/lib/owner";
import OwnersAdmin from "./OwnersAdmin";

// Owner-only, like every /dev page: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Owners — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/** Who is the owner: the site_role table (lib/site-role.ts, docs/secrets-and-auth.md). */
export default async function DevOwnersPage() {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
  return (
    <main lang="zh" className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <h1 className="font-brush text-4xl">所有者</h1>
      <p className="text-sm opacity-70">
        所有者能打开所有 /dev 页面和后台接口。名单只存在数据库里，改动不用部署， 30
        秒内对所有服务器生效，每次改动都记在安全审计日志里。地址必须完全一致： Gmail 地址里的点和 +
        后缀都算另一个人。唯一的所有者不能撤销。
      </p>
      <OwnersAdmin self={normalizeEmail(user?.email)} />
    </main>
  );
}
