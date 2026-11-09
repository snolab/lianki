import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { dbBackend } from "@/lib/d1";
import TokensClient from "./TokensClient";
import { devPageText, devPageMetadata } from "../dev-page-title";

// Owner-only, like every /dev page: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("tokens", { referrer: "no-referrer" });

/** Dev access tokens for the dev server's tunnel (lib/dev-access.ts, docs/dev-whole-page.md). */
export default async function DevTokensPage() {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) notFound();
  if (dbBackend() !== "d1") return <main className="p-8">D1 only.</main>;
  const heading = await devPageText("tokens");
  return (
    <main lang="zh" className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 lang={heading.lang} className="font-brush text-4xl">
          {heading.text}
        </h1>
        <p className="text-sm opacity-60">
          只有你能看到这页。令牌让你的设备经 https://preview.lianki.com
          打开预览版（试用代码，用的是生产数据），
          并自动以你的账号登录。令牌只显示一次；撤销后，用它建立的会话在 30 秒内失效。
        </p>
      </header>
      <TokensClient />
    </main>
  );
}
