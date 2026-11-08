import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import FlagsAdmin from "./FlagsAdmin";

// Owner-only, like /dev/credits: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Flags — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

export default async function DevFlagsPage() {
  const user = await authUserOrNull();
  if (!isAdmin(user?.email)) notFound();
  return (
    <main lang="zh" className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <h1 className="font-brush text-4xl">开关</h1>
      <p className="text-sm opacity-70">
        功能开关：不用部署、不用改密钥，在这里打开或关闭。默认全部关闭；读不到开关时也当作关闭。
        改动 30 秒内对所有请求生效，每次改动都记下是谁、什么时候。
      </p>
      <FlagsAdmin />
    </main>
  );
}
