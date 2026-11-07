import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import BoxClientsAdmin from "./BoxClientsAdmin";

// Owner-only, like /dev/flags: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Boxes — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

export default async function DevBoxClientsPage() {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
  return (
    <main lang="zh" className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <h1 className="font-brush text-4xl">开发盒登录</h1>
      <p className="text-sm opacity-70">
        每个开发盒（my-&lt;hash&gt;.lianki.com 或
        my-&lt;名字&gt;.lianki.com）只能用绑定的那一个账号登录，一个账号也只有一个盒子。
        盒子用该账号自己的权限访问 lianki.com 的 API，只能碰允许的路由。还需要打开开关{" "}
        <code>box.oauth</code>（/dev/flags）。「撤销」会立刻让这个盒子的所有令牌失效。
        说明：docs/box-oauth.md。
      </p>
      <BoxClientsAdmin />
    </main>
  );
}
