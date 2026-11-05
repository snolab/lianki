"use client";

import { useEffect, useState } from "react";
import { FLAGS, type FlagDef, type FlagKey } from "@/lib/flags";
import type { FlagLogEntry, FlagRow } from "@/lib/flags-store";
import type { PrereqFailure } from "@/lib/flag-prereqs";

type State = {
  flags: FlagRow[];
  /** The prerequisites each flag fails now (reason keys and texts only). */
  prereqs?: Partial<Record<FlagKey, PrereqFailure[]>>;
  log: FlagLogEntry[];
  cacheSeconds: number;
};

/** Shown under every flag that moves real money (policy: typed Slack confirmation). */
export const MONEY_NOTE = "打开正式收款前请在 Slack 打字确认";

/** Written out, in JST, labelled — the owner reads every time in JST. */
const jst = (iso: string) =>
  `${new Date(iso).toLocaleString("zh-CN", {
    timeZone: "Asia/Tokyo",
    dateStyle: "long",
    timeStyle: "short",
  })} JST`;

const card =
  "rounded-lg border border-[oklch(0_0_0/0.1)] dark:border-[oklch(1_0_0/0.1)] p-4 space-y-2";

/**
 * One flag. A flag whose prerequisites fail cannot be turned on: its switch is
 * greyed and disabled, with every reason listed. If it is on anyway (turned on
 * before the check existed, or a secret removed since), the switch stays
 * usable so it can always be turned off — the kill switch.
 */
export function FlagCard({
  flag: f,
  failed = [],
  busy,
  onToggle,
}: {
  flag: FlagRow;
  failed?: PrereqFailure[];
  busy: boolean;
  onToggle: () => void;
}) {
  const blocked = failed.length > 0;
  const locked = blocked && !f.enabled;
  const money = (FLAGS[f.key] as FlagDef).money === true;
  return (
    <section className={card} data-flag={f.key} data-blocked={blocked || undefined}>
      <div className="flex items-center justify-between gap-3">
        <code className="font-mono text-sm break-all">{f.key}</code>
        <button
          type="button"
          role="switch"
          aria-checked={f.enabled}
          aria-label={f.key}
          aria-describedby={blocked ? `prereq-${f.key}` : undefined}
          disabled={busy || locked}
          title={locked ? "条件未满足，不能打开" : undefined}
          onClick={onToggle}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            f.enabled ? "bg-[oklch(0.62_0.17_150)]" : "bg-[oklch(0.8_0_0)] dark:bg-[oklch(0.4_0_0)]"
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
      {blocked && (
        <ul
          id={`prereq-${f.key}`}
          className="text-xs space-y-0.5 text-[oklch(0.55_0.17_45)] dark:text-[oklch(0.78_0.14_60)]"
        >
          {failed.map((r) => (
            <li key={r.check} data-reason={r.reason}>
              {f.enabled ? "条件未满足（只能关闭）：" : "不能打开："}
              {r.text}
            </li>
          ))}
        </ul>
      )}
      {money && <p className="text-xs font-bold">{MONEY_NOTE}</p>}
      <p className="text-xs opacity-60">
        {f.enabled ? "开" : "关"}
        {f.updatedAt ? ` · ${f.updatedBy} · ${jst(f.updatedAt)}` : " · 从未改过（默认关）"}
      </p>
    </section>
  );
}

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
        <FlagCard
          key={f.key}
          flag={f}
          failed={state.prereqs?.[f.key]}
          busy={busy !== null}
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
