"use client";

import { useEffect, useState } from "react";
import type { FlagLogEntry, FlagRow } from "@/lib/flags-store";

type State = { flags: FlagRow[]; log: FlagLogEntry[]; cacheSeconds: number };

/** Written out, in JST, labelled — the owner reads every time in JST. */
const jst = (iso: string) =>
  `${new Date(iso).toLocaleString("zh-CN", {
    timeZone: "Asia/Tokyo",
    dateStyle: "long",
    timeStyle: "short",
  })} JST`;

const card =
  "rounded-lg border border-[oklch(0_0_0/0.1)] dark:border-[oklch(1_0_0/0.1)] p-4 space-y-2";

/** Every registry flag with a switch; each change is logged on the server. */
export default function FlagsAdmin() {
  const [state, setState] = useState<State | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/dev/flags", { cache: "no-store" });
      if (r.ok) setState(await r.json());
      else setMsg(`HTTP ${r.status}`);
    })();
  }, []);

  async function toggle(f: FlagRow) {
    const enabled = !f.enabled;
    // Payment flags move real money: ask once before turning one on.
    if (enabled && f.key.startsWith("payments.") && !window.confirm(`打开 ${f.key}？`)) return;
    setBusy(f.key);
    setMsg(null);
    try {
      const r = await fetch("/api/dev/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: f.key, enabled }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        setState(data);
        setMsg(`${f.key} → ${enabled ? "开" : "关"}（${data.cacheSeconds ?? 30} 秒内生效）`);
      } else setMsg(data.error ?? `HTTP ${r.status}`);
    } finally {
      setBusy(null);
    }
  }

  if (!state) return <p className="text-sm opacity-70">{msg ?? "…"}</p>;
  return (
    <div className="space-y-4">
      {state.flags.map((f) => (
        <section key={f.key} className={card} data-flag={f.key}>
          <div className="flex items-center justify-between gap-3">
            <code className="font-mono text-sm break-all">{f.key}</code>
            <button
              type="button"
              role="switch"
              aria-checked={f.enabled}
              aria-label={f.key}
              disabled={busy !== null}
              onClick={() => void toggle(f)}
              className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                f.enabled
                  ? "bg-[oklch(0.62_0.17_150)]"
                  : "bg-[oklch(0.8_0_0)] dark:bg-[oklch(0.4_0_0)]"
              }`}
            >
              <span
                className={`absolute top-1 h-5 w-5 rounded-full bg-[oklch(1_0_0)] transition-all ${
                  f.enabled ? "left-6" : "left-1"
                }`}
              />
            </button>
          </div>
          <p className="text-sm">{f.description}</p>
          <p className="text-xs opacity-60">
            {f.enabled ? "开" : "关"}
            {f.updatedAt ? ` · ${f.updatedBy} · ${jst(f.updatedAt)}` : " · 从未改过（默认关）"}
          </p>
        </section>
      ))}

      {msg && <p className="text-sm">{msg}</p>}

      <section className={card}>
        <h2 className="font-bold text-sm">改动记录</h2>
        {state.log.length === 0 ? (
          <p className="text-xs opacity-60">还没有改动。</p>
        ) : (
          <ul className="text-xs font-mono space-y-1">
            {state.log.map((e, i) => (
              <li key={i}>
                {jst(e.at)} · {e.key} → {e.enabled ? "开" : "关"} · {e.by}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
