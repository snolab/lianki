"use client";

import { useEffect, useState } from "react";

type Allowed = {
  userId: string;
  email: string | null;
  name: string | null;
  addedBy: string;
  addedAt: number;
};
type Preview = {
  id: string;
  userId: string;
  email: string | null;
  target: string;
  expiresAt: number;
};
type State = { allowed: Allowed[]; previews: Preview[] };

/** Written out, in JST, labelled — the owner reads every time in JST. */
const jst = (ms: number) =>
  `${new Date(ms).toLocaleString("zh-CN", {
    timeZone: "Asia/Tokyo",
    dateStyle: "long",
    timeStyle: "short",
  })} JST`;

const card =
  "rounded-lg border border-[oklch(0_0_0/0.1)] dark:border-[oklch(1_0_0/0.1)] p-4 space-y-2";
const btn =
  "rounded-md px-3 py-1 text-sm border border-[oklch(0_0_0/0.2)] dark:border-[oklch(1_0_0/0.2)] disabled:opacity-50";

/** The allowlist (add by email, remove) and every active preview (stop). */
export default function LiveFrontendsAdmin() {
  const [state, setState] = useState<State | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/dev/live-frontends", { cache: "no-store" });
      if (r.ok) setState(await r.json());
      else setMsg(`HTTP ${r.status}`);
    })();
  }, []);

  async function op(body: Record<string, string>, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/dev/live-frontends", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        setState(data);
        setMsg(done);
      } else setMsg(data.error ?? `HTTP ${r.status}`);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <p className="text-sm opacity-70">{msg ?? "…"}</p>;
  return (
    <div className="space-y-4">
      <section className={card}>
        <h2 className="font-bold text-sm">名单</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) void op({ op: "add", email: email.trim() }, `已添加 ${email.trim()}`);
          }}
        >
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="用户的登录邮箱"
            aria-label="用户的登录邮箱"
            className="flex-1 rounded-md px-2 py-1 text-sm border border-[oklch(0_0_0/0.2)] dark:border-[oklch(1_0_0/0.2)] bg-transparent"
          />
          <button type="submit" className={btn} disabled={busy}>
            添加
          </button>
        </form>
        {state.allowed.length === 0 ? (
          <p className="text-xs opacity-60">还没有人。</p>
        ) : (
          <ul className="text-sm space-y-1">
            {state.allowed.map((a) => (
              <li key={a.userId} className="flex items-center justify-between gap-2">
                <span className="break-all">
                  {a.email ?? a.userId}
                  {a.name ? ` (${a.name})` : ""}
                  <span className="text-xs opacity-60"> · {jst(a.addedAt)}</span>
                </span>
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `移除 ${a.email ?? a.userId}？他的预览会全部停止，盒子也会被撤销。`,
                      )
                    )
                      void op({ op: "remove", userId: a.userId }, "已移除");
                  }}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {msg && <p className="text-sm">{msg}</p>}

      <section className={card}>
        <h2 className="font-bold text-sm">正在进行的预览</h2>
        {state.previews.length === 0 ? (
          <p className="text-xs opacity-60">没有。</p>
        ) : (
          <ul className="text-sm space-y-1">
            {state.previews.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <span className="break-all">
                  {p.email ?? p.userId} · <code className="text-xs">{p.target}</code>
                  <span className="text-xs opacity-60"> · 到 {jst(p.expiresAt)}</span>
                </span>
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => void op({ op: "revoke", id: p.id }, "已停止")}
                >
                  停止
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
