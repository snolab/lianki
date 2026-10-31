"use client";

import { useEffect, useState } from "react";
import {
  QUIET_HOURS_EVENT,
  QUIET_HOURS_KEY,
  type QuietHours,
  DEFAULT_QUIET_HOURS,
  quietHours,
  setQuietHours,
} from "@lianki/debug-chat/quiet-hours";

/**
 * The learning partner's quiet hours, in the /words Settings sheet (debug
 * mode only): on/off, from, to. Device-local (`lk:agent-quiet-hours`, never
 * synced: docs/prefs-sync.md); the chat reads it as each agent line arrives
 * (packages/debug-chat/src/quiet-hours.ts).
 */
export function QuietHoursSetting({
  text,
  Toggle,
}: {
  text: { label: string; hint: string; from: string; to: string };
  Toggle: (p: {
    on: boolean;
    onChange: (on: boolean) => void;
    label: string;
    hint?: string;
  }) => React.ReactNode;
}) {
  // The default on the server and the first paint; this device's value after mount.
  const [q, setQ] = useState<QuietHours>(DEFAULT_QUIET_HOURS);
  useEffect(() => {
    const load = () => setQ(quietHours());
    load();
    const onStorage = (e: StorageEvent) => e.key === QUIET_HOURS_KEY && load();
    window.addEventListener(QUIET_HOURS_EVENT, load);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(QUIET_HOURS_EVENT, load);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const save = (next: Partial<QuietHours>) => setQ(setQuietHours({ ...q, ...next }));
  const time = (which: "from" | "to", label: string) => (
    <label className="inline-flex items-center gap-1 text-xs">
      <span className="opacity-70">{label}</span>
      <input
        type="time"
        // 16px: iOS zooms into a smaller input on focus.
        className="rounded bg-black/5 px-1 py-0.5 text-[16px] tabular-nums dark:bg-white/10"
        value={q[which]}
        disabled={!q.on}
        data-quiet-hours={which}
        onChange={(e) => e.currentTarget.value && save({ [which]: e.currentTarget.value })}
      />
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-2" data-quiet-hours-setting>
      <Toggle on={q.on} onChange={(on) => save({ on })} label={text.label} hint={text.hint} />
      {time("from", text.from)}
      {time("to", text.to)}
    </div>
  );
}
