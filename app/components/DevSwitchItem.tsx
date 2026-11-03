"use client";

import { useEffect, useState } from "react";
import {
  backUrl,
  devServerUp,
  switchToDevServer,
  type DevSwitchMode,
} from "@/lib/dev-server-switch";

export type DevSwitchLabels = {
  name: string;
  off: string;
  checking: string;
};

export type DevSwitch = { mode: Exclude<DevSwitchMode, null>; labels: DevSwitchLabels };

const BLUE = "oklch(0.62 0.19 255)";

/**
 * The owner's "Preview build" toggle in the account menu
 * (lib/dev-server-switch.ts; owner, 2026-11-03 14:45 JST: a switch). On =
 * the dev server, off = lianki.com; flipping it moves the same page across.
 * It exists only while the menu is open, and on lianki.com checks once when
 * it mounts: no polling, nothing left running after the menu closes.
 */
export function DevSwitchItem({ sw }: { sw: DevSwitch }) {
  const on = sw.mode === "back";
  const [up, setUp] = useState<boolean | null>(on ? true : null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (sw.mode !== "go") return;
    let live = true;
    void devServerUp().then((u) => live && setUp(u));
    return () => {
      live = false;
    };
  }, [sw.mode]);

  const label = up ? sw.labels.name : up === null ? sw.labels.checking : sw.labels.off;
  const cls =
    "flex items-center gap-3 w-full text-start px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700";
  const inner = (
    <>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      <span
        aria-hidden
        className={`relative inline-block w-9 h-5 shrink-0 rounded-full transition-colors ${on ? "" : "bg-gray-300 dark:bg-gray-600"} ${up === null ? "animate-pulse" : ""}`}
        style={on ? { background: BLUE } : undefined}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow ${on ? "start-[18px]" : "start-0.5"}`}
        />
      </span>
    </>
  );
  // On (the dev server): flipping it off is a plain link to the same page on
  // lianki.com, with no Referer.
  if (on)
    return (
      <a
        role="switch"
        aria-checked
        data-dev-switch="back"
        href={backUrl(location)}
        referrerPolicy="no-referrer"
        className={cls}
      >
        {inner}
      </a>
    );
  return (
    <button
      type="button"
      role="switch"
      aria-checked={false}
      data-dev-switch="go"
      disabled={!up || busy}
      onClick={async () => {
        setBusy(true);
        if (!(await switchToDevServer(location))) setBusy(false);
      }}
      className={`${cls} ${up ? "" : "opacity-50"}`}
    >
      {inner}
    </button>
  );
}

/**
 * On the dev server only: a small blue dot on the corner of the profile
 * menu's button (owner, 2026-11-03 14:44 JST), instead of a top-bar badge.
 * The menu's switch, on, says what it means.
 */
export function DevServerDot({ label }: { label: string }) {
  return (
    <span
      data-dev-server-dot
      className="pointer-events-none absolute -top-0.5 -end-0.5 w-2 h-2 rounded-full ring-2 ring-white dark:ring-gray-900"
      style={{ background: BLUE }}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}
