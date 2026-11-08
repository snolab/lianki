"use client";

// The word review's bottom sheet (lib/read/review-sheet.ts holds the rules):
// it slides up on open, rests at a share of the screen with the text visible
// above, follows a drag on its top band (taller, shorter, or away), and slides
// down before it closes. The height is kept as a snap index, so turning the
// phone keeps the same resting share.

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { releaseVelocity } from "@/lib/words/swipe";
import { dragHeight, sheetRelease, sheetSnaps } from "@/lib/read/review-sheet";

/** The slide in and out, and the settle after a drag. */
export const SHEET_EASE =
  "transform 0.3s cubic-bezier(.2,.9,.3,1), height 0.3s cubic-bezier(.2,.9,.3,1)";
const SLIDE_MS = 300;
/** The default resting snap: the middle one (three quarters of the screen). */
const START = 1;

const viewH = () => window.visualViewport?.height ?? window.innerHeight;
/** The notch's height (0 where there is none), for what stays visible above the sheet. */
function safeTop(): number {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-top);visibility:hidden";
  document.body.appendChild(el);
  const h = el.getBoundingClientRect().height;
  el.remove();
  return h;
}
const still = () =>
  document.documentElement.dataset.motion === "off" ||
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

type Drag = { id: number; y0: number; h0: number; dy: number; samples: { t: number; x: number }[] };

export function useReviewSheet(onClose: () => void) {
  const [vh, setVh] = useState(() => (typeof window === "undefined" ? 800 : viewH()));
  const [top, setTop] = useState(0);
  const [snap, setSnap] = useState(START);
  const [shown, setShown] = useState(false);
  const [live, setLive] = useState<{ h0: number; h: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const closing = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    setTop(safeTop());
    const on = () => setVh(viewH());
    window.visualViewport?.addEventListener("resize", on);
    window.addEventListener("resize", on);
    // Slides up on the frame after it is drawn closed.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    return () => {
      cancelAnimationFrame(raf);
      window.visualViewport?.removeEventListener("resize", on);
      window.removeEventListener("resize", on);
    };
  }, []);

  // Always visible above the tallest sheet: the notch and an eighth of the screen of text.
  const snaps = sheetSnaps(vh, top + Math.round(vh / 8));
  const rest = snaps[Math.min(snap, snaps.length - 1)] ?? vh;

  const dismiss = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setLive(null);
    setShown(false);
    setTimeout(() => close.current(), still() ? 0 : SLIDE_MS);
  }, []);

  const down = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,a,input")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      id: e.pointerId,
      y0: e.clientY,
      h0: rest,
      dy: 0,
      samples: [{ t: performance.now(), x: 0 }],
    };
    setLive({ h0: rest, h: rest });
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = e.clientY - d.y0;
    const now = performance.now();
    d.samples = [...d.samples.filter((s) => now - s.t < 200), { t: now, x: d.dy }];
    setLive({ h0: d.h0, h: dragHeight(d.h0, d.dy, snaps) });
  };
  const up = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const r = sheetRelease(d.h0, d.dy, releaseVelocity(d.samples, performance.now()), snaps);
    if (r.close) return dismiss();
    setSnap(Math.max(0, snaps.indexOf(r.h)));
    setLive(null);
  };
  const cancel = () => {
    drag.current = null;
    setLive(null);
  };

  // While dragged down the sheet slides (no relayout of the list under the
  // finger); dragged up it grows. At rest: its snap, or below the screen.
  const box = live ? Math.max(live.h0, live.h) : rest;
  const offset = live ? `${box - live.h}px` : shown ? "0px" : "100%";
  return {
    height: `${box}px`,
    h: Math.round(live?.h ?? rest),
    offset,
    shown,
    dragging: !!live,
    dismiss,
    down,
    move,
    up,
    cancel,
  };
}
