import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend, getD1 } from "@/lib/d1";
import { listDevUsers } from "@/lib/repos/devUsersD1";
import UsersTable from "./UsersTable";

// Owner-only, like /dev/roadmap: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Users — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

export default async function DevUsersPage() {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
  if (dbBackend() !== "d1") return <main className="p-8">D1 only.</main>;
  const rows = await listDevUsers(getD1());
  return (
    <main lang="zh" className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="font-brush text-4xl">用户</h1>
        <p className="text-sm opacity-60">
          只有你能看到这页。全站账号的会员、活跃度和数据量；点邮箱去 /dev/membership 加 Pro。
          数据量是各表文本长度的估算。
        </p>
      </header>
      <UsersTable rows={rows} now={Date.now()} />
    </main>
  );
}
