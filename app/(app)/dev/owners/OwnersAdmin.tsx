"use client";

import { useCallback, useEffect, useState } from "react";

type Row = { email: string; granted_by: string; granted_at: number };

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** List, grant and revoke owners. /api/dev/owners checks everything again. */
export default function OwnersAdmin({ self }: { self: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = useCallback(async (r: Response) => {
    // No longer the owner (his own revocation took effect): this page is gone too.
    if (r.status === 404) return location.reload();
    const j = (await r.json().catch(() => ({}))) as { owners?: Row[]; error?: string };
    if (j.owners) setRows(j.owners);
    setErr(r.ok ? "" : (j.error ?? `HTTP ${r.status}`));
  }, []);

  useEffect(() => {
    void fetch("/api/dev/owners", { cache: "no-store" }).then(apply);
  }, [apply]);

  async function change(op: "grant" | "revoke", target: string) {
    setBusy(true);
    try {
      await apply(
        await fetch("/api/dev/owners", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op, email: target }),
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  function grant() {
    const target = email.trim().toLowerCase();
    if (!target) return;
    if (!window.confirm(`把 ${target} 设为所有者？这个地址将拥有全部 /dev 权限。`)) return;
    void change("grant", target).then(() => setEmail(""));
  }

  function revoke(target: string) {
    const msg =
      target === self
        ? `撤销你自己（${target}）的所有者身份？撤销后你会失去这个页面。`
        : `撤销 ${target} 的所有者身份？30 秒内生效。`;
    if (window.confirm(msg)) void change("revoke", target);
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-semibold">当前所有者</h2>
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {rows.map((r) => (
            <li key={r.email} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="font-mono break-all">{r.email}</span>
              {r.email === self && <span className="opacity-60">（你）</span>}
              <span className="opacity-60">
                {fmt(r.granted_at)} · {r.granted_by}
              </span>
              <button
                onClick={() => revoke(r.email)}
                disabled={busy || rows.length < 2}
                title={rows.length < 2 ? "唯一的所有者不能撤销" : undefined}
                className="ml-auto text-red-600 disabled:opacity-40"
              >
                撤销
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">授予</h2>
        <div className="flex flex-wrap gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
            placeholder="完整的邮箱地址"
            aria-label="邮箱地址"
            autoComplete="off"
            className="min-w-0 flex-1 border rounded px-2 py-1 bg-transparent"
          />
          <button
            onClick={grant}
            disabled={busy || !email.trim()}
            className="rounded bg-black text-white dark:bg-white dark:text-black px-3 py-1 disabled:opacity-40"
          >
            授予
          </button>
        </div>
        <p className="text-sm opacity-60">这里不会告诉你这个地址有没有账号。</p>
      </section>
      {err && <p className="text-red-600 text-sm">{err}</p>}
    </div>
  );
}
