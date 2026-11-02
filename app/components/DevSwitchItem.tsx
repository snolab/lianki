"use client";

import { useEffect, useState } from "react";
import {
  backUrl,
  devServerUp,
  switchToDevServer,
  type DevSwitchMode,
} from "@/lib/dev-server-switch";

export type DevSwitchLabels = {
  open: string;
  off: string;
  checking: string;
  back: string;
  badge: string;
};

export type DevSwitch = { mode: Exclude<DevSwitchMode, null>; labels: DevSwitchLabels };

/**
 * The owner's dev-server item in the account menu (lib/dev-server-switch.ts).
 * It exists only while the menu is open, and checks once when it mounts:
 * no polling, nothing left running after the menu closes.
 */
export function DevSwitchItem({ sw }: { sw: DevSwitch }) {
  const [up, setUp] = useState<boolean | null>(sw.mode === "back" ? true : null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (sw.mode !== "go") return;
    let live = true;
    void devServerUp().then((u) => live && setUp(u));
    return () => {
      live = false;
    };
  }, [sw.mode]);

  const cls =
    "flex items-center gap-2 w-full text-start px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700";
  if (sw.mode === "back")
    return (
      <a
        data-dev-switch="back"
        href={backUrl(location)}
        referrerPolicy="no-referrer"
        className={cls}
      >
        {sw.labels.back}
      </a>
    );
  return (
    <button
      data-dev-switch="go"
      disabled={!up || busy}
      onClick={async () => {
        setBusy(true);
        if (!(await switchToDevServer(location))) setBusy(false);
      }}
      className={`${cls} ${up ? "text-amber-700 dark:text-amber-400" : "opacity-50"}`}
    >
      <span
        aria-hidden
        className={`inline-block w-2 h-2 rounded-full ${up ? "bg-green-500" : up === null ? "bg-amber-400 animate-pulse" : "bg-gray-400"}`}
      />
      {up ? sw.labels.open : up === null ? sw.labels.checking : sw.labels.off}
    </button>
  );
}

/** The dev server's top-bar label, so it is never mistaken for the public site. */
export function DevServerBadge({ label }: { label: string }) {
  return (
    <span
      data-dev-server-badge
      className="rounded-full bg-amber-500 text-black text-xs font-semibold px-2 py-0.5 whitespace-nowrap"
    >
      {label}
    </span>
  );
}
