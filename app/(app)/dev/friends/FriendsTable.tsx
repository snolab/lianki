"use client";

import Link from "next/link";
import { useState } from "react";
import type { Friend } from "@/lib/push-friends";

/** ISO order, in the viewer's time zone: 2026-10-29 18:11. */
const when = (at: number) =>
  new Date(at).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });

/** The chat's users, newest message first, each with Block / Unblock. */
export default function FriendsTable({ friends }: { friends: Friend[] }) {
  const [rows, setRows] = useState(friends);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (f: Friend) => {
    setBusy(f.userId);
    setError(null);
    try {
      const res = await fetch("/api/dev/friends", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: f.userId, action: f.blocked ? "unblock" : "block" }),
      });
      const out = (await res.json()) as { friend?: Friend; error?: string };
      if (!res.ok || !out.friend) throw new Error(out.error ?? `HTTP ${res.status}`);
      const next = out.friend;
      setRows((list) => list.map((x) => (x.userId === next.userId ? next : x)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (rows.length === 0) return <p className="opacity-60">还没有人用过聊天。</p>;
  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" style={{ color: "oklch(0.55 0.2 25)" }}>
          {error}
        </p>
      )}
      <table className="w-full text-sm">
        <thead className="text-left opacity-60">
          <tr>
            <th className="py-1">邮箱</th>
            <th>首次</th>
            <th>最近消息</th>
            <th className="text-right">消息数</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr
              key={f.userId}
              className="border-t"
              style={{ borderColor: "oklch(0.5 0 0 / 0.2)", opacity: f.blocked ? 0.55 : 1 }}
              data-friend={f.userId}
            >
              <td className="py-1">
                <Link href={`/dev/friends?thread=${f.userId}`} className="underline">
                  {f.email || f.userId}
                </Link>
                {f.blocked && <span className="ml-2 text-xs">已屏蔽</span>}
              </td>
              <td>{when(f.firstSeen)}</td>
              <td>{when(f.lastAt)}</td>
              <td className="text-right">{f.count}</td>
              <td className="text-right">
                <button
                  type="button"
                  disabled={busy === f.userId}
                  onClick={() => toggle(f)}
                  className="rounded px-2 py-0.5 text-xs"
                  style={{
                    background: f.blocked ? "oklch(0.5 0.1 230)" : "oklch(0.5 0.17 25)",
                    color: "oklch(0.98 0 0)",
                  }}
                >
                  {f.blocked ? "解除屏蔽" : "屏蔽"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
