"use client";

// The small ▶ beside a sung line (docs/youtube-song-examples.md). It sits inside
// a swipeable reader row, whose gestures listen natively on the row: so the
// button listens natively too and stops the event there, before the row's
// swipe, tap or word lookup sees it. A real tap: the popup's player may start.

import { useEffect, useRef } from "react";

export function ClipButton({
  label,
  onPlay,
}: {
  label: string;
  onPlay: (el: HTMLElement) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const play = useRef(onPlay);
  play.current = onPlay;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    const click = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      play.current(el);
    };
    const kinds = ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown"] as const;
    for (const k of kinds) el.addEventListener(k, stop, { passive: true });
    el.addEventListener("click", click);
    return () => {
      for (const k of kinds) el.removeEventListener(k, stop);
      el.removeEventListener("click", click);
    };
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      data-yt-clip=""
      className="me-1.5 inline-flex h-6 w-6 select-none items-center justify-center rounded-full align-[-0.2em] text-[0.7rem] text-[oklch(0.42_0.17_25)] ring-1 ring-[oklch(0.42_0.17_25/0.35)] hover:bg-[oklch(0.6_0.17_25/0.12)] dark:text-[oklch(0.8_0.13_25)] dark:ring-[oklch(0.8_0.13_25/0.4)]"
    >
      ▶
    </button>
  );
}
