"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEV_SERVER_ORIGIN, postToDevServer } from "@/lib/dev-server-switch";

type Row = {
  id: string;
  name: string;
  created_ms: number;
  expires_ms: number;
  revoked_ms: number | null;
  last_used_ms: number | null;
};

const fmt = (ms: number | null) =>
  ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—";

/** Mint, list and revoke dev access tokens. A new token is held in memory only, until the page is left. */
export default function TokensClient() {
  const [rows, setRows] = useState<Row[]>([]);
  const [name, setName] = useState("iPhone");
  const [days, setDays] = useState(30);
  const [fresh, setFresh] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const tokenRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/dev/dev-tokens", { cache: "no-store" });
    if (r.ok) setRows(((await r.json()) as { tokens: Row[] }).tokens);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function mint() {
    setErr("");
    const r = await fetch("/api/dev/dev-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, days }),
    });
    const j = (await r.json()) as { token?: string; error?: string };
    if (!r.ok || !j.token) return setErr(j.error ?? `HTTP ${r.status}`);
    setFresh(j.token);
    void load();
  }

  async function revoke(id: string) {
    await fetch(`/api/dev/dev-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
    void load();
  }

  async function endAll() {
    await fetch("/api/dev/dev-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revokeAll: true }),
    });
    setFresh(null);
    void load();
  }

  const now = Date.now();
  return (
    <div className="space-y-6">
      <section className="space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <h2 className="font-semibold">新令牌</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            className="border rounded px-2 py-1 bg-transparent"
            aria-label="名称"
          />
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="border rounded px-2 py-1 bg-transparent"
            aria-label="有效期"
          >
            {[1, 7, 30, 90].map((d) => (
              <option key={d} value={d}>
                {d} 天
              </option>
            ))}
          </select>
          <button
            onClick={mint}
            className="rounded bg-black text-white dark:bg-white dark:text-black px-3 py-1"
          >
            生成
          </button>
        </div>
        {err && <p className="text-red-600 text-sm">{err}</p>}
        {fresh && (
          <div className="space-y-2 text-sm">
            <p>只显示这一次。离开本页后再也看不到。</p>
            <input
              ref={tokenRef}
              readOnly
              value={fresh}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full font-mono text-xs border rounded px-2 py-1 bg-transparent"
            />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void navigator.clipboard.writeText(fresh)}
                className="rounded border px-3 py-1"
              >
                复制令牌
              </button>
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(
                    `${DEV_SERVER_ORIGIN}/_lk/dev-auth#token=${fresh}`,
                  )
                }
                className="rounded border px-3 py-1"
              >
                复制给另一台设备的链接
              </button>
              <button
                onClick={() => postToDevServer(fresh, "/__dev/landing")}
                className="rounded border px-3 py-1"
              >
                在本设备打开开发服务器
              </button>
            </div>
            <p className="opacity-60">
              链接里令牌在 # 之后：不会发给任何服务器，打开后立刻从地址栏去掉。工具用
              <code> Authorization: Bearer &lt;令牌&gt;</code>。
            </p>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">令牌</h2>
          <button onClick={endAll} className="text-sm text-red-600">
            全部撤销（结束所有开发服务器会话）
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="text-left opacity-60">
            <tr>
              <th>名称</th>
              <th>到期</th>
              <th>上次使用</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const live = !r.revoked_ms && r.expires_ms > now;
              return (
                <tr key={r.id} className={live ? "" : "opacity-40"}>
                  <td>{r.name}</td>
                  <td>{r.revoked_ms ? `已撤销 ${fmt(r.revoked_ms)}` : fmt(r.expires_ms)}</td>
                  <td>{fmt(r.last_used_ms)}</td>
                  <td className="text-right">
                    {live && (
                      <button onClick={() => void revoke(r.id)} className="text-red-600">
                        撤销
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
