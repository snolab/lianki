"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  backUrl,
  devServerUp,
  switchToDevServer,
  type DevSwitchMode,
} from "@/lib/dev-server-switch";
import { SealStamp } from "./SealSwitch";
import { Icon } from "./icons";

export type DevSwitchLabels = {
  name: string;
  off: string;
  checking: string;
};

export type DevSwitch = { mode: Exclude<DevSwitchMode, null>; labels: DevSwitchLabels };

/**
 * The owner's "Preview build" toggle in the account menu
 * (lib/dev-server-switch.ts; owner, 2026-11-03 14:45 JST: a switch). On =
 * the dev server, off = lianki.com; flipping it moves the same page across.
 * Drawn as the box seal every switch uses (SealSwitch.tsx).
 * It exists only while the menu is open, and on lianki.com checks once when
 * it mounts: no polling, nothing left running after the menu closes.
 *
 * It is the menu's one preview control: `children` (the Live view chip,
 * LiveView.tsx) sit on a second line inside the same row, not as a second
 * switch (owner, 2026-11-03 20:00 JST).
 */
export function DevSwitchItem({ sw, children }: { sw: DevSwitch; children?: ReactNode }) {
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
      <span aria-hidden className={up === null ? "animate-pulse" : undefined}>
        <SealStamp on={on} size="sm" pending={busy} />
      </span>
    </>
  );
  // On (the dev server): flipping it off is a plain link to the same page on
  // lianki.com, with no Referer.
  const control = on ? (
    <a
      role="switch"
      aria-checked
      aria-busy={busy || undefined}
      data-dev-switch="back"
      href={backUrl(location)}
      referrerPolicy="no-referrer"
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) setBusy(true);
      }}
      className={cls}
    >
      {inner}
    </a>
  ) : (
    <button
      type="button"
      role="switch"
      aria-checked={false}
      aria-busy={busy || undefined}
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
  if (!children) return control;
  return (
    <div data-preview-row>
      {control}
      <div className="px-4 pb-2 -mt-0.5">{children}</div>
    </div>
  );
}

/**
 * Preview environment marker, anchored to the avatar. A flask with an explicit
 * preview label distinguishes this state from an unread-notification dot.
 */
export function DevServerBadge({ label }: { label: string }) {
  return (
    <span
      data-dev-server-badge
      role="img"
      aria-label={label}
      title={label}
      className="absolute -top-1 -end-1 flex size-4 items-center justify-center rounded-md border border-sky-200 bg-white text-sky-700 shadow-sm dark:border-sky-700 dark:bg-gray-900 dark:text-sky-300"
    >
      <Icon name="flask" className="size-3" />
    </span>
  );
}
