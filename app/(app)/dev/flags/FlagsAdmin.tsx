"use client";

import { useEffect, useState } from "react";
import type { FlagKey } from "@/lib/flags";
import type { FlagLogEntry, FlagRow } from "@/lib/flags-store";
import type { PrereqFailure } from "@/lib/flag-prereqs";
import { card, FlagCard, jst } from "./FlagCard";
import { FLAG_HIGHLIGHT_MS, scrollToFlag } from "./flag-anchor";

type State = {
  flags: FlagRow[];
  /** The prerequisites each flag fails now (reason keys and texts only). */
  prereqs?: Partial<Record<FlagKey, PrereqFailure[]>>;
  log: FlagLogEntry[];
  cacheSeconds: number;
};

/** Every registry flag with a switch; each change is logged on the server. */
export default function FlagsAdmin() {
  const [state, setState] = useState<State | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const loaded = state !== null;

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/dev/flags", { cache: "no-store" });
      if (r.ok) setState(await r.json());
      else setMsg(`HTTP ${r.status}`);
    })();
  }, []);

  // /dev/flags#<key>: the cards exist only after the fetch above, so the browser's
  // own jump to the fragment finds nothing. This effect runs once they are in the DOM.
  useEffect(() => {
    if (!loaded) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const goToHash = () => {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const key = scrollToFlag(document, window.location.hash, reduce);
      if (!key) return;
      setHighlighted(key);
      clearTimeout(timer);
      timer = setTimeout(() => setHighlighted(null), FLAG_HIGHLIGHT_MS);
    };
    goToHash();
    window.addEventListener("hashchange", goToHash);
    return () => {
      window.removeEventListener("hashchange", goToHash);
      clearTimeout(timer);
    };
  }, [loaded]);

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
        <FlagCard
          key={f.key}
          flag={f}
          failed={state.prereqs?.[f.key]}
          busy={busy !== null}
          highlighted={highlighted === f.key}
          onToggle={() => void toggle(f)}
        />
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
