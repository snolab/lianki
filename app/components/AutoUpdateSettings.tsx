"use client";

// Settings → Updates: a new version applies itself on a clean page, or not
// (lib/auto-update.ts). Follows the account (`app.autoUpdate`).

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import { AUTO_UPDATE_KEY, autoUpdatePref, setAutoUpdatePref } from "@/lib/auto-update";
import { SealSwitch } from "@/app/components/SealSwitch";

export function AutoUpdateSettings() {
  const c = useIntlayer("auto-update-pref");
  const [on, setOn] = useState(true);
  useEffect(() => {
    const read = () => setOn(autoUpdatePref());
    const onApplied = (e: Event) => {
      if ((e as CustomEvent<{ key?: string }>).detail?.key === "app.autoUpdate") read();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTO_UPDATE_KEY) read();
    };
    read();
    window.addEventListener(PREF_APPLIED_EVENT, onApplied);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, onApplied);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return (
    <section id="auto-update" className="mb-10 max-w-md scroll-mt-6" data-section="auto-update">
      <h2 className="text-2xl font-semibold mb-4 text-gray-900 dark:text-white">{c.heading}</h2>
      <div className="flex items-center gap-3">
        <span id="pref-auto-update-label" className="flex-1">
          {c.label}
        </span>
        <SealSwitch
          checked={on}
          data-testid="pref-auto-update"
          aria-labelledby="pref-auto-update-label"
          onClick={() => {
            setOn(!on);
            setAutoUpdatePref(!on);
          }}
        />
      </div>
      <p className="text-xs text-gray-500 mt-1">{c.help}</p>
    </section>
  );
}
