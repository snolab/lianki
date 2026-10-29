"use client";

import { useMemo, useState } from "react";
import type { DevUserRow } from "@/lib/repos/devUsersD1";

/** ISO-style, in the viewer's time zone: 2026-11-05 18:11. Never 11/5/2026. */
const when = (s: string | null) =>
  s ? new Date(s).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) : "—";

const size = (b: number) =>
  b < 1024
    ? `${b} B`
    : b < 1048576
      ? `${(b / 1024).toFixed(1)} KB`
      : `${(b / 1048576).toFixed(1)} MB`;

const tier = (u: DevUserRow, now: number) =>
  u.proEndsAt && Date.parse(u.proEndsAt) > now
    ? "pro"
    : u.trialEndsAt && Date.parse(u.trialEndsAt) > now
      ? "trial"
      : "free";

type Key = "lastSeen" | "createdAt" | "words" | "reviews7d" | "pages" | "bytes";
const COLUMNS: [Key, string][] = [
  ["lastSeen", "最近登录"],
  ["createdAt", "注册"],
  ["words", "单词"],
  ["reviews7d", "7天复习"],
  ["pages", "Lianki 卡片"],
  ["bytes", "数据量"],
];

/** Every account: filter by email or name, sort by any column. */
export default function UsersTable({ rows, now }: { rows: DevUserRow[]; now: number }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Key>("lastSeen");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const val = (u: DevUserRow) => (sort === "lastSeen" ? (u.lastSeen ?? "") : u[sort]);
    return rows
      .filter((u) => !needle || `${u.email} ${u.name ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        const x = val(a);
        const y = val(b);
        return typeof x === "number" ? (y as number) - x : String(y).localeCompare(String(x));
      });
  }, [rows, q, sort]);

  const week = now - 7 * 86_400_000;
  const stat = (label: string, n: number | string) => (
    <div className="rounded border border-current/15 px-3 py-2">
      <div className="text-xs opacity-60">{label}</div>
      <div className="text-lg tabular-nums">{n}</div>
    </div>
  );

  return (
    <div className="space-y-4" data-dev-users>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {stat("账号", rows.length)}
        {stat("7天内登录", rows.filter((u) => u.lastSeen && Date.parse(u.lastSeen) > week).length)}
        {stat("7天内复习", rows.filter((u) => u.reviews7d > 0).length)}
        {stat(
          "Pro / 试用",
          `${rows.filter((u) => tier(u, now) === "pro").length} / ${rows.filter((u) => tier(u, now) === "trial").length}`,
        )}
        {stat("数据总量", size(rows.reduce((s, u) => s + u.bytes, 0)))}
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索邮箱或名字"
        className="w-full rounded border border-current/20 bg-transparent px-3 py-2"
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left opacity-60">
              <th className="py-1 pr-3 font-normal">账号</th>
              <th className="py-1 pr-3 font-normal">会员</th>
              {COLUMNS.map(([k, label]) => (
                <th key={k} className="py-1 pr-3 font-normal whitespace-nowrap">
                  <button
                    onClick={() => setSort(k)}
                    className={sort === k ? "underline font-medium opacity-100" : ""}
                  >
                    {label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => {
              const t = tier(u, now);
              return (
                <tr key={u.id} className="border-t border-current/10 align-top" data-user={u.email}>
                  <td className="py-1.5 pr-3">
                    <a
                      href={`/dev/membership?email=${encodeURIComponent(u.email)}`}
                      className="underline"
                    >
                      {u.email}
                    </a>
                    {u.name && <div className="text-xs opacity-60">{u.name}</div>}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {t}
                    {t === "pro" && (
                      <div className="text-xs opacity-60">至 {when(u.proEndsAt)}</div>
                    )}
                    {t === "trial" && (
                      <div className="text-xs opacity-60">至 {when(u.trialEndsAt)}</div>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {when(u.lastSeen)}
                    <div className="text-xs opacity-60">
                      {u.sessions} 会话{u.passkeys ? ` · ${u.passkeys} 通行密钥` : ""}
                    </div>
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{when(u.createdAt)}</td>
                  <td className="py-1.5 pr-3">{u.words}</td>
                  <td className="py-1.5 pr-3">
                    {u.reviews7d}
                    <div className="text-xs opacity-60">共 {u.wordReviews}</div>
                  </td>
                  <td className="py-1.5 pr-3">
                    {u.pages}
                    {u.reads > 0 && <div className="text-xs opacity-60">{u.reads} 阅读</div>}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{size(u.bytes)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
