"use client";

/**
 * Live view in the shell (docs/live-view.md): the owner's chip in the
 * account menu's preview row, and the banner while his dev JS is loaded. The server sets
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
  /**
   * A dev machine has shared parts: the stored pointer's branch@sha, verified
   * on the server, whether or not this device's switch is on (so the menu
   * can offer it). Null when there is none.
   */
  ready: string | null;
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

/**
 * Live view's place in the account menu: not a second switch but a small
 * chip inside the "Preview build" row (owner, 2026-11-03 20:00 JST: "两个
 * 『预览』的 Switch，有什么区别吗？"). The row's switch moves the whole page to
 * the preview build; this chip keeps the page on lianki.com and swaps in only
 * the dev machine's parts (widget, islands), on this device. It shows only
 * when a dev machine has shared parts (`ready`) or it is already on.
 */
export function LiveViewChip({ lv }: { lv: LiveViewShell }) {
  const s = useLiveView();
  if (!lv.wanted && !lv.ready) return null;
  const sub = s.on
    ? liveLabel(s.claim)
    : !lv.wanted
      ? lv.ready
      : s.note && s.note !== "expired"
        ? `${lv.labels.refused} (${s.note.replace(/^live view refused: /, "")})`
        : lv.labels.waiting;
  return (
    <button
      type="button"
      aria-pressed={lv.wanted}
      data-live-view-switch={lv.wanted ? "on" : "off"}
      onClick={() => flip(!lv.wanted)}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 min-h-7 text-xs ${
        lv.wanted
          ? "border-transparent bg-[oklch(0.92_0.09_85)] text-[oklch(0.32_0.07_60)] dark:bg-[oklch(0.38_0.08_70)] dark:text-[oklch(0.95_0.04_85)]"
          : "border-[oklch(0.85_0_0)] dark:border-[oklch(0.45_0_0)] text-gray-600 dark:text-gray-300"
      }`}
    >
      <span
        aria-hidden
        className={`inline-block w-2 h-2 shrink-0 rounded-full ${
          lv.wanted ? "bg-[oklch(0.65_0.2_40)]" : "border border-current"
        }`}
      />
      <span className="shrink-0">{lv.labels.liveView}</span>
      {sub && <span className="min-w-0 truncate font-mono opacity-80">· {sub}</span>}
    </button>
  );
}
