import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import BoxClientsAdmin from "./BoxClientsAdmin";
import { devPageText, devPageMetadata } from "../dev-page-title";

// Owner-only, like /dev/flags: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("boxClients");

export default async function DevBoxClientsPage() {
  const user = await authUserOrNull();
  if (!isAdmin(user?.email)) notFound();
  const heading = await devPageText("boxClients");
  return (
    <main lang="zh" className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <h1 lang={heading.lang} className="font-brush text-4xl">
        {heading.text}
      </h1>
      <p className="text-sm opacity-70">
        每个开发盒（my-&lt;hash&gt;.lianki.com 或
        my-&lt;名字&gt;.lianki.com）只能用绑定的那一个账号登录，一个账号也只有一个盒子。
        盒子用该账号自己的权限访问 lianki.com 的 API，只能碰允许的路由。还需要打开开关{" "}
        <code>box.oauth</code>（/dev/flags）。「撤销」会立刻让这个盒子的所有令牌失效。
        账号必须在下面的盒子名单上（站点所有者除外），否则不能绑定，已有的盒子也什么都做不了。
        说明：docs/box-oauth.md。
      </p>
      <BoxClientsAdmin />
    </main>
  );
}
