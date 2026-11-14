"use client";

// Settings → Notifications: what the number on the installed app's icon
// counts (lib/app-badge.ts, docs/app-badge.md). Follows the account
// (`notify.badge`). Shown only when appBadgeOn (lib/app-badge-gate.ts): flag on, the owner.

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import {
  BADGE_DEFAULT,
  BADGE_MODE_EVENT,
  BADGE_MODES,
  BADGE_PREF_KEY,
  type BadgeMode,
  parseBadgeMode,
  readBadgeMode,
  writeBadgeMode,
} from "@/lib/app-badge";

const LABEL_OF: Record<BadgeMode, "off" | "asks" | "due" | "both"> = {
  off: "off",
  "ask-cards": "asks",
  "due-cards": "due",
  both: "both",
};

export function AppBadgeSettings() {
  const c = useIntlayer("app-badge");
  const [mode, setMode] = useState<BadgeMode>(BADGE_DEFAULT);

  useEffect(() => {
    const read = () => setMode(readBadgeMode());
    read();
    const onApplied = (e: Event) => {
      if ((e as CustomEvent<{ key?: string }>).detail?.key === "notify.badge") read();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === BADGE_PREF_KEY) read();
    };
    window.addEventListener(PREF_APPLIED_EVENT, onApplied);
    window.addEventListener(BADGE_MODE_EVENT, read);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, onApplied);
      window.removeEventListener(BADGE_MODE_EVENT, read);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <section className="mb-10 max-w-xl" data-section="notifications" data-testid="app-badge">
      <h2 className="mb-3 break-words text-2xl font-semibold">{c.heading}</h2>
      <label className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 basis-full sm:basis-auto sm:flex-1">{c.label}</span>
        <select
          className="min-h-11 w-full rounded-lg sm:w-auto border border-[oklch(0.5_0.02_250/0.35)] bg-[oklch(0.99_0_0)] px-3 text-[oklch(0.25_0.02_250)] dark:bg-[oklch(0.25_0.01_250)] dark:text-[oklch(0.95_0.01_250)] pointer-fine:min-h-9"
          value={mode}
          data-testid="app-badge-mode"
          onChange={(e) => {
            const m = parseBadgeMode(e.target.value);
            setMode(m);
            writeBadgeMode(m);
          }}
        >
          {BADGE_MODES.map((m) => (
            <option key={m} value={m}>
              {c[LABEL_OF[m]].value}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs text-[oklch(0.45_0.02_250)] dark:text-[oklch(0.75_0.02_250)]">
        {c.help}
      </p>
    </section>
  );
}
