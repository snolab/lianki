import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isAdmin } from "@/lib/permissions";
import { dbBackend, getBlobs, getD1 } from "@/lib/d1";
import { INBOX } from "@/lib/inbox/config";
import { cachedReadBlobSizes, type ListBucket } from "@/lib/repos/devUserFiles";
import { listDevUsers, monthlySignups } from "@/lib/repos/devUsersD1";
import { monthSeries } from "@/lib/signups-chart";
import SignupsChart from "./SignupsChart";
import UsersTable from "./UsersTable";
import { devPageText, devPageMetadata } from "../dev-page-title";

// Owner-only, like /dev/roadmap: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("users");

export default async function DevUsersPage() {
  const user = await authUserOrNull();
  if (!isAdmin(user?.email)) notFound();
  if (dbBackend() !== "d1") return <main className="p-8">D1 only.</main>;
  // Long reading texts have no stored size: R2's listing, capped and cached (devUserFiles.ts).
  const read = await cachedReadBlobSizes(() => getBlobs() as unknown as ListBucket);
  const now = new Date();
  const [rows, signups, heading] = await Promise.all([
    listDevUsers(getD1(), now, read.sizes),
    monthlySignups(getD1()),
    devPageText("users"),
  ]);
  return (
    <main lang="zh" className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 lang={heading.lang} className="font-brush text-4xl">
          {heading.text}
        </h1>
        <p className="text-sm opacity-60">
          只有你能看到这页。全站账号的会员、活跃度和数据量；点邮箱去 /dev/membership 加 Pro。
          库内文本是数据库各表文本长度的估算；文件是存在 R2
          的文件（收件箱、头像、长阅读文本）的实际字节。
        </p>
      </header>
      <SignupsChart series={monthSeries(signups, now)} />
      <UsersTable
        rows={rows}
        now={now.getTime()}
        inboxCap={INBOX.maxStoredBytes}
        filesComplete={read.complete}
      />
    </main>
  );
}
