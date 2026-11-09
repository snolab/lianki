import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";
import { INBOX } from "@/lib/inbox/config";
import { cachedReadBlobSizes, type ListBucket } from "@/lib/repos/devUserFiles";
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
  if (!isAdmin(user?.email)) notFound();
  if (dbBackend() !== "d1") return <main className="p-8">D1 only.</main>;
  // Long reading texts have no stored size: R2's listing, capped and cached (devUserFiles.ts).
  const read = await cachedReadBlobSizes(() => getBlobs() as unknown as ListBucket);
  const rows = await listDevUsers(getD1(), new Date(), read.sizes);
  return (
    <main lang="zh" className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="font-brush text-4xl">用户</h1>
        <p className="text-sm opacity-60">
          只有你能看到这页。全站账号的会员、活跃度和数据量；点邮箱去 /dev/membership 加 Pro。
          库内文本是数据库各表文本长度的估算；文件是存在 R2
          的文件（收件箱、头像、长阅读文本）的实际字节。
        </p>
      </header>
      <UsersTable
        rows={rows}
        now={Date.now()}
        inboxCap={INBOX.maxStoredBytes}
        filesComplete={read.complete}
      />
    </main>
  );
}
