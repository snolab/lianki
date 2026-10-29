"use client";

import { useEffect, useState } from "react";
import type { GiftCodeRow } from "@/lib/referrals/store";

export function GiftCodesClient() {
  const [codes, setCodes] = useState<GiftCodeRow[]>([]);
  const [days, setDays] = useState(7);
  const [maxUses, setMaxUses] = useState(1);
  const [note, setNote] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function load() {
    const res = await fetch("/api/gift-codes");
    if (res.ok) setCodes(((await res.json()) as { codes: GiftCodeRow[] }).codes);
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/gift-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        days,
        maxUses,
        note: note || undefined,
        expiresAt: expiresAt || undefined,
      }),
    });
    if (!res.ok) {
      setError(`失败（${res.status}）`);
      return;
    }
    setMade(((await res.json()) as { code: string }).code);
    setNote("");
    load();
  }

  const field =
    "rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2";
  return (
    <div className="space-y-6">
      <form onSubmit={create} className="grid grid-cols-2 gap-3 sm:grid-cols-4 items-end">
        <label className="space-y-1 text-sm">
          <span>天数</span>
          <input
            type="number"
            min={1}
            max={3660}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className={`${field} w-full`}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>可用次数</span>
          <input
            type="number"
            min={1}
            max={100000}
            value={maxUses}
            onChange={(e) => setMaxUses(Number(e.target.value))}
            className={`${field} w-full`}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>到期（可选）</span>
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className={`${field} w-full`}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>备注</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="发给谁"
            className={`${field} w-full`}
          />
        </label>
        <button
          type="submit"
          className="col-span-2 sm:col-span-4 rounded-lg bg-blue-600 text-white px-4 py-2 font-semibold"
        >
          生成
        </button>
      </form>
      {error && <p className="text-red-600">{error}</p>}
      {made && (
        <p className="text-lg">
          新码：<code className="font-mono font-bold select-all">{made}</code>
        </p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left opacity-60">
            <th>码</th>
            <th>天数</th>
            <th>已用/次数</th>
            <th>到期</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {codes.map((c) => (
            <tr key={c.code} className="border-t border-gray-200 dark:border-gray-700">
              <td className="font-mono select-all py-1">{c.code}</td>
              <td>{c.days}</td>
              <td>
                {c.uses}/{c.maxUses}
              </td>
              <td>{c.expiresAt ? c.expiresAt.slice(0, 10) : "—"}</td>
              <td>{c.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
