import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import LiveFrontendsAdmin from "./LiveFrontendsAdmin";

// Owner-only, like /dev/flags: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Custom frontends — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

export default async function DevLiveFrontendsPage() {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
  return (
    <main lang="zh" className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <h1 className="font-brush text-4xl">自定义前端</h1>
      <p className="text-sm opacity-70">
        名单上的用户可以登记自己的 Cloudflare 隧道，在 lianki.com/?live=&lt;id&gt;
        看到自己开发的前端；/api 和 /auth 永远是正式版，只用他自己的账号和权限，只有他本人能看到。
        还需要打开开关 <code>my-box</code>
        （/dev/flags）。移除一个人会同时停止他所有的预览。
        每次改动都记在安全审计日志里。说明：docs/custom-frontend.md。
      </p>
      <LiveFrontendsAdmin />
    </main>
  );
}
