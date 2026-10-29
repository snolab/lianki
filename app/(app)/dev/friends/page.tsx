import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { isUserId } from "@/lib/dev-eval";
import { friendThread, listFriends } from "@/lib/push-friends";
import FriendsTable from "./FriendsTable";

// Owner-only, like /dev/users: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Friends — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

/** ISO order, local time: 2026-10-29 18:11. */
const when = (at: number) =>
  new Date(at).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });

/**
 * Everyone who has used the debug chat (docs/monitoring.md, "Friends"), with
 * Block. `?thread=<userId>` adds that user's thread below, read-only.
 */
export default async function DevFriendsPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
  const { thread } = await searchParams;
  const friends = await listFriends();
  if (!friends)
    return <main className="p-8">lianki-push is not bound here (production Worker only).</main>;
  const open = isUserId(thread) ? friends.find((f) => f.userId === thread) : undefined;
  const messages = open ? await friendThread(open.userId) : null;
  return (
    <main lang="zh" className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="font-brush text-4xl">朋友</h1>
        <p className="text-sm opacity-60">
          只有你能看到这页。用过调试聊天的人：聊天不用审批；「屏蔽」会立刻断开他们的连接并拒绝之后的聊天。
          在他们设备上跑代码（预览）要他们自己在设备上点允许。
        </p>
      </header>
      <FriendsTable friends={friends} />
      {open && (
        <section aria-label={`Thread of ${open.email}`} className="space-y-2">
          <h2 className="text-lg">
            {open.email} 的对话（只读） ·{" "}
            <Link href="/dev/friends" className="underline">
              关闭
            </Link>
          </h2>
          <ol className="space-y-1 text-sm">
            {(messages ?? []).map((m) => (
              <li key={m.id}>
                <span className="opacity-60">
                  {when(m.at)} · {m.from === "agent" ? m.label || "agent" : m.email || "friend"} ·{" "}
                  {m.from !== "agent" && <span title={m.label}>{m.label.split(" ")[0]}</span>}
                </span>
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
              </li>
            ))}
            {messages?.length === 0 && <li className="opacity-60">（没有消息）</li>}
          </ol>
        </section>
      )}
    </main>
  );
}
