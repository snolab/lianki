"use client";

/**
 * Live view in the shell (docs/live-view.md): the owner's switch in the
 * account menu, and the banner while his dev JS is loaded. The server sets
 * `LiveViewShell` for the owner only (lib/live-view/shell.server.ts); anyone
 * else's page renders none of this.
 */
import { useEffect } from "react";
import { liveView, setLiveWanted, useLiveView } from "@/lib/live-view/client";
import { liveLabel } from "@/lib/live-view/rules";

export type LiveViewLabels = { liveView: string; normal: string; waiting: string; refused: string };

export type LiveViewShell = {
  /** This device's switch is on (the lk_live_view cookie). */
  wanted: boolean;
  /** The stored pointer, signed by the dev key; the page verifies it again. */
  token: string | null;
  labels: LiveViewLabels;
};

const flip = (on: boolean) => {
  setLiveWanted(on);
  location.reload();
};

/** Verifies the pointer on this page and, while live, shows the banner. */
export function LiveViewBoot({ lv }: { lv: LiveViewShell }) {
  const s = useLiveView();
  useEffect(() => {
    void liveView.start(lv.wanted ? lv.token : null);
    return () => liveView.stop();
  }, [lv.wanted, lv.token]);
  if (!s.on) return null;
  return <LiveViewBanner label={liveLabel(s.claim)} labels={lv.labels} />;
}

export function LiveViewBanner({ label, labels }: { label: string; labels: LiveViewLabels }) {
  return (
    <div
      data-live-view-banner
      role="status"
      className="relative z-30 flex items-center gap-2 px-4 py-1 text-xs font-medium shrink-0 bg-[oklch(0.92_0.09_85)] text-[oklch(0.32_0.07_60)] dark:bg-[oklch(0.38_0.08_70)] dark:text-[oklch(0.95_0.04_85)] border-b border-[oklch(0.8_0.1_80)] dark:border-[oklch(0.48_0.09_70)]"
    >
      <span
        aria-hidden
        className="inline-block w-2 h-2 rounded-full bg-[oklch(0.65_0.2_40)] animate-pulse"
      />
      <span className="min-w-0 truncate">
        {labels.liveView} · <span className="font-mono">{label}</span>
      </span>
      <button
        type="button"
        data-live-view-exit
        onClick={() => flip(false)}
        className="ms-auto shrink-0 rounded-full px-3 min-h-7 border border-current/40 hover:bg-[oklch(0.85_0.1_85)] dark:hover:bg-[oklch(0.45_0.08_70)]"
      >
        {labels.normal}
      </button>
    </div>
  );
}

/** The account-menu row: Live view ⇄ Normal, for this device. */
export function LiveViewItem({ lv }: { lv: LiveViewShell }) {
  const s = useLiveView();
  const sub = !lv.wanted
    ? null
    : s.on
      ? liveLabel(s.claim)
      : s.note && s.note !== "expired"
        ? `${lv.labels.refused} (${s.note.replace(/^live view refused: /, "")})`
        : lv.labels.waiting;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={lv.wanted}
      data-live-view-switch={lv.wanted ? "on" : "off"}
      onClick={() => flip(!lv.wanted)}
      className="flex items-center gap-2 w-full text-start px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
    >
      <span className="flex-1 min-w-0">
        <span className="block">
          {lv.labels.liveView} ⇄ {lv.labels.normal}
        </span>
        {sub && <span className="block text-xs opacity-70 truncate font-mono">{sub}</span>}
      </span>
      <span
        aria-hidden
        className={`shrink-0 inline-flex w-8 h-5 rounded-full p-0.5 transition-colors ${
          lv.wanted
            ? "bg-[oklch(0.7_0.15_70)] justify-end"
            : "bg-[oklch(0.8_0_0)] dark:bg-[oklch(0.45_0_0)]"
        }`}
      >
        <span className="w-4 h-4 rounded-full bg-[oklch(0.99_0_0)]" />
      </span>
    </button>
  );
}
