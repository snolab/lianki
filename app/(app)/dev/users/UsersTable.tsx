"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import { compactBytes as size } from "@/lib/repos/devUserFiles";
import type { DevUserRow } from "@/lib/repos/devUsersD1";
import type { PendingRow } from "@/lib/referrals/pregrant";

/** ISO-style, in the viewer's time zone: 2026-11-05 18:11. Never 11/5/2026. */
const when = (s: string | null) =>
  s ? new Date(s).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) : "—";

const tier = (u: DevUserRow, now: number) =>
  u.proEndsAt && Date.parse(u.proEndsAt) > now
    ? "pro"
    : u.trialEndsAt && Date.parse(u.trialEndsAt) > now
      ? "trial"
      : "free";

type Key = "lastSeen" | "createdAt" | "words" | "reviews7d" | "pages" | "bytes" | "files";

/** Every account: filter by email or name, sort by any column. */
export default function UsersTable({
  rows,
  now,
  inboxCap,
  filesComplete = true,
  pending = [],
}: {
  rows: DevUserRow[];
  now: number;
  /** Per-account inbox safety cap in bytes (lib/inbox/config.ts). */
  inboxCap: number;
  /** False when the R2 listing hit its page cap: totals are a lower bound. */
  filesComplete?: boolean;
  /** Open pre-grants (lib/referrals/pregrant.ts): addresses with no account yet, revocable. */
  pending?: PendingRow[];
}) {
  const c = useIntlayer("dev-users");
  const p = useIntlayer("dev-pregrant");
  const router = useRouter();
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeFailed, setRevokeFailed] = useState(false);
  async function revoke(row: PendingRow) {
    if (!window.confirm(p.revokeConfirm.value.replace("{email}", row.email))) return;
    setRevoking(row.id);
    setRevokeFailed(false);
    try {
      const r = await fetch(`/api/dev/pregrants?id=${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      if (!r.ok && r.status !== 409) throw new Error(String(r.status));
      router.refresh();
    } catch {
      setRevokeFailed(true);
    } finally {
      setRevoking(null);
    }
  }
  const COLUMNS: [Key, string][] = [
    ["lastSeen", "最近登录"],
    ["createdAt", "注册"],
    ["words", "单词"],
    ["reviews7d", "7天复习"],
    ["pages", "Lianki 卡片"],
    ["bytes", c.dbText.value],
    ["files", c.files.value],
  ];
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
  const pendingShown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return pending.filter(
      (r) => !needle || `${r.email} ${r.note ?? ""}`.toLowerCase().includes(needle),
    );
  }, [pending, q]);

  const week = now - 7 * 86_400_000;
  const stat = (label: string, n: number | string) => (
    <div className="rounded border border-current/15 px-3 py-2">
      <div className="text-xs opacity-60">{label}</div>
      <div className="text-lg tabular-nums">{n}</div>
    </div>
  );

  return (
    <div className="space-y-4" data-dev-users>
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        {stat("账号", rows.length)}
        {stat("7天内登录", rows.filter((u) => u.lastSeen && Date.parse(u.lastSeen) > week).length)}
        {stat("7天内复习", rows.filter((u) => u.reviews7d > 0).length)}
        {stat(
          "Pro / 试用",
          `${rows.filter((u) => tier(u, now) === "pro").length} / ${rows.filter((u) => tier(u, now) === "trial").length}`,
        )}
        {stat(c.dbTextTotal.value, size(rows.reduce((s, u) => s + u.bytes, 0)))}
        {stat(
          c.filesTotal.value,
          `${filesComplete ? "" : "≥ "}${size(rows.reduce((s, u) => s + u.files, 0))}`,
        )}
      </div>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索邮箱或名字"
        className="w-full rounded border border-current/20 bg-transparent px-3 py-2"
      />
      {revokeFailed && (
        <p
          role="alert"
          className="text-sm text-[oklch(0.5_0.19_27)] dark:text-[oklch(0.75_0.15_27)]"
        >
          {p.failed}
        </p>
      )}
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
            {pendingShown.map((r) => {
              const lapsed = r.grantExpiresAt !== null && Date.parse(r.grantExpiresAt) <= now;
              return (
                <tr
                  key={`pending-${r.id}`}
                  className="border-t border-current/10 align-top"
                  data-pending={r.email}
                >
                  <td className="py-1.5 pr-3">
                    <span className="break-all">{r.email}</span>
                    {r.note && <div className="text-xs opacity-60 break-all">{r.note}</div>}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span
                      className={
                        lapsed
                          ? "text-[oklch(0.5_0.19_27)] dark:text-[oklch(0.75_0.15_27)]"
                          : "text-[oklch(0.45_0.12_70)] dark:text-[oklch(0.82_0.12_80)]"
                      }
                    >
                      {lapsed ? p.expired : p.pending}
                    </span>
                    <div className="text-xs opacity-60">
                      {p.pendingDays.value.replace("{days}", String(r.days))}
                    </div>
                    {r.grantExpiresAt && (
                      <div className="text-xs opacity-60">
                        {p.lapses.value.replace("{date}", when(r.grantExpiresAt))}
                      </div>
                    )}
                    <button
                      data-revoke={r.id}
                      disabled={revoking === r.id}
                      onClick={() => revoke(r)}
                      className="mt-1 rounded border border-current/30 px-2 py-0.5 text-xs disabled:opacity-40"
                    >
                      {p.revoke}
                    </button>
                  </td>
                  <td className="py-1.5 pr-3">—</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{when(r.createdAt)}</td>
                  <td className="py-1.5 pr-3" colSpan={COLUMNS.length - 2} />
                </tr>
              );
            })}
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
                  <td className="py-1.5 pr-3 whitespace-nowrap" data-files={u.files}>
                    {size(u.files)}
                    {u.inboxBytes > 0 && (
                      <div className="text-xs opacity-60">
                        {c.inboxCap.value
                          .replace("{used}", size(u.inboxBytes))
                          .replace("{limit}", size(inboxCap))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
