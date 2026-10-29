"use client";

import { useState } from "react";

type View = { email: string; tier: string; trialEndsAt: string | null; proEndsAt: string | null };

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

/** Look an account up, see its tier and Pro end, then add days. */
export default function GrantPro({ defaultEmail }: { defaultEmail: string }) {
  const [email, setEmail] = useState(defaultEmail);
  const [days, setDays] = useState(7);
  const [view, setView] = useState<View | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async (init?: RequestInit) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(
        init ? "/api/dev/membership" : `/api/dev/membership?email=${encodeURIComponent(email)}`,
        init,
      );
      const data = await r.json();
      if (!r.ok) {
        setView(null);
        setMsg(data.error ?? `HTTP ${r.status}`);
        return null;
      }
      setView(data);
      return data as View;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-grant-pro>
      <label className="block space-y-1">
        <span className="text-sm opacity-70">账号邮箱</span>
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setView(null);
          }}
          className="w-full rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-3 py-2"
        />
      </label>
      <button
        onClick={() => void call()}
        disabled={busy || !email}
        className="rounded-lg border border-black/15 dark:border-white/15 px-4 py-2"
      >
        查询
      </button>

      {view && (
        <div
          className="rounded-lg border border-black/10 dark:border-white/10 p-4 space-y-1 text-sm"
          data-membership-view
        >
          <div>
            <b>{view.email}</b> · <span data-tier>{view.tier}</span>
          </div>
          <div>Pro 到期：{day(view.proEndsAt)}</div>
          <div className="opacity-60">试用到期：{day(view.trialEndsAt)}</div>
          <div className="flex items-center gap-2 pt-3">
            <input
              type="number"
              min={1}
              max={3660}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-24 rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-3 py-2"
            />
            <span>天</span>
            <button
              onClick={async () => {
                const v = await call({
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ email: view.email, days }),
                });
                if (v) setMsg(`已加 ${days} 天，Pro 到 ${day(v.proEndsAt)}`);
              }}
              disabled={busy || days < 1}
              className="rounded-lg bg-[var(--brand)] px-4 py-2 text-white"
            >
              加 Pro
            </button>
          </div>
        </div>
      )}
      {msg && (
        <p className="text-sm" data-grant-msg>
          {msg}
        </p>
      )}
    </div>
  );
}
