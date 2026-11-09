"use client";

/**
 * The /words list's pinch for card height (lib/words/row-pinch.ts holds the
 * maths). Two fingers on the list, moved apart or together vertically, set
 * every row's height; the rows follow the fingers, and on lifting settle on a
 * whole line (no animation with motion off). The choice is the synced pref
 * `words.cardHeight` (docs/prefs-sync.md).
 *
 * The page never zooms: two-finger touchmoves are cancelled and Safari's own
 * `gesturestart` too; the list says `touch-action: pan-y`. One finger is the
 * swipe's as before: a second finger cancels the row gestures the fingers
 * started (a pointercancel on their rows), so a pinch never grades, taps or
 * reads aloud.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { notePrefWrite, PREF_APPLIED_EVENT } from "@lianki/ui-state";
import { motionOff } from "@/lib/motion-pref";
import { ROW_LINE_LH } from "@/lib/words/row-layout";
import {
  asFactor,
  CARD_HEIGHT_KEY,
  minJerk,
  pinchBounds,
  pinchHeight,
  rowHeightFor,
  settleHeight,
  toFactor,
  verticalSpan,
  type RowNeed,
} from "@/lib/words/row-pinch";

/** The settle's length, ms: the swipe's own settle is of this order. */
const SETTLE_MS = 180;
/** A pinch's anchor holds this long after the last height change it caused. */
const ANCHOR_MS = 400;

/** Lines a back cell needs to be shown in full (`data-back-cell` on a Glance). */
function cellLines(o: HTMLElement): number {
  const lh = parseFloat(getComputedStyle(o).fontSize) * ROW_LINE_LH || 1;
  const inner = o.firstElementChild as HTMLElement | null;
  // Wrapping cells are clamped by a max height; the inner box holds the whole text.
  if (o.style.maxHeight && inner) return Math.max(1, Math.ceil((inner.scrollHeight - 1) / lh));
  // One-line cells clip: the outer box's scroll width is the text on one line.
  // Wrapped, a line ends at a word, so a little more than the plain ratio.
  const w = Math.max(1, o.clientWidth);
  return Math.max(1, Math.ceil((o.scrollWidth * 1.08 - 1) / w));
}

/** What the rows on screen need, from their back cells. */
export function measureNeeds(list: HTMLElement): RowNeed[] {
  const out: RowNeed[] = [];
  for (const row of list.querySelectorAll<HTMLElement>("[data-i]")) {
    const need = { first: 0, second: 0 };
    for (const c of row.querySelectorAll<HTMLElement>("[data-back-cell]")) {
      const n = cellLines(c);
      if (c.dataset.backCell === "2") need.second += n;
      else need.first += n;
    }
    out.push(need);
  }
  return out;
}

function readFactor(): number {
  try {
    return asFactor(localStorage.getItem(CARD_HEIGHT_KEY) ?? 1);
  } catch {
    return 1;
  }
}

export interface RowPinch {
  /** The rows' height now. */
  rowH: number;
  /** Where in the list the pinch is centred (px from its top), while it is fresh; else null. */
  anchor: () => number | null;
}

export function useRowPinch({
  list,
  on,
  touch,
  k,
  defaultH,
}: {
  list: HTMLElement | null;
  /** The flag `words.pinch-card-height`. Off: the default height, no gesture. */
  on: boolean;
  touch: boolean;
  /** The cards' text scale (rowMetrics' `k`). */
  k: number;
  /** The row height rowMetrics gives. */
  defaultH: number;
}): RowPinch {
  const [factor, setFactor] = useState(1);
  const read = useCallback(() => setFactor(readFactor()), []);
  useEffect(() => {
    read();
    window.addEventListener(PREF_APPLIED_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PREF_APPLIED_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [read]);
  /** The height while fingers are down or it settles; null at rest. */
  const [live, setLive] = useState<number | null>(null);
  const rowH = on ? (live ?? rowHeightFor(defaultH, factor)) : defaultH;
  const now = useRef(rowH);
  now.current = rowH;
  const anchorAt = useRef<{ y: number; t: number } | null>(null);
  const opts = useRef({ k, touch, defaultH });
  opts.current = { k, touch, defaultH };

  useEffect(() => {
    if (!list || !on || !touch) return;
    let p: {
      startH: number;
      span: number;
      bounds: { min: number; max: number };
      h: number;
      frame: number;
    } | null = null;
    let tween = 0;
    const floor = () => opts.current.defaultH / 2;
    const ys = (t: TouchList): [number, number] => [t[0].clientY, t[1].clientY];
    const mark = (t: TouchList) => {
      const top = list.getBoundingClientRect().top;
      anchorAt.current = { y: (t[0].clientY + t[1].clientY) / 2 - top, t: performance.now() };
    };
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 2 || p) return;
      cancelAnimationFrame(tween);
      // The rows the fingers came down on drop their gesture: no grade, tap or hold.
      for (const t of Array.from(e.touches))
        t.target.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
      const startH = now.current;
      const { k: kk, touch: tt } = opts.current;
      p = {
        startH,
        span: verticalSpan(ys(e.touches), floor()),
        bounds: pinchBounds(measureNeeds(list), kk, tt, startH),
        h: startH,
        frame: 0,
      };
      mark(e.touches);
    };
    const move = (e: TouchEvent) => {
      if (!p || e.touches.length < 2) return;
      if (e.cancelable) e.preventDefault();
      p.h = pinchHeight(p.startH, p.span, verticalSpan(ys(e.touches), floor()), p.bounds);
      mark(e.touches);
      if (!p.frame)
        p.frame = requestAnimationFrame(() => {
          if (!p) return;
          p.frame = 0;
          setLive(p.h);
        });
    };
    const save = (h: number) => {
      const f = toFactor(h, opts.current.defaultH);
      try {
        localStorage.setItem(CARD_HEIGHT_KEY, String(f));
      } catch {}
      notePrefWrite();
      anchorAt.current = anchorAt.current && { ...anchorAt.current, t: performance.now() };
      setFactor(f);
      setLive(null);
    };
    const end = (e: TouchEvent) => {
      if (!p || e.touches.length >= 2) return;
      const done = p;
      p = null;
      cancelAnimationFrame(done.frame);
      const { k: kk, touch: tt, defaultH: d } = opts.current;
      const to = settleHeight(done.h, kk, tt, d, done.bounds);
      // Motion off: no settle, just the new height.
      if (motionOff() || Math.abs(to - done.h) < 0.5) return save(to);
      const from = done.h;
      const t0 = performance.now();
      const step = () => {
        const x = (performance.now() - t0) / SETTLE_MS;
        if (anchorAt.current) anchorAt.current.t = performance.now();
        if (x >= 1) return save(to);
        setLive(from + (to - from) * minJerk(x));
        tween = requestAnimationFrame(step);
      };
      tween = requestAnimationFrame(step);
    };
    // While a pinch is on, the rows never see its pointers.
    const swallow = (e: PointerEvent) => {
      if (p && e.pointerType === "touch") e.stopPropagation();
    };
    // Safari's own pinch: never the page's zoom here.
    const gesture = (e: Event) => e.preventDefault();
    list.addEventListener("touchstart", start, { passive: true });
    list.addEventListener("touchmove", move, { passive: false });
    list.addEventListener("touchend", end);
    list.addEventListener("touchcancel", end);
    for (const t of ["pointerdown", "pointermove", "pointerup"] as const)
      list.addEventListener(t, swallow, true);
    list.addEventListener("gesturestart", gesture);
    list.addEventListener("gesturechange", gesture);
    return () => {
      cancelAnimationFrame(tween);
      if (p) cancelAnimationFrame(p.frame);
      list.removeEventListener("touchstart", start);
      list.removeEventListener("touchmove", move);
      list.removeEventListener("touchend", end);
      list.removeEventListener("touchcancel", end);
      for (const t of ["pointerdown", "pointermove", "pointerup"] as const)
        list.removeEventListener(t, swallow, true);
      list.removeEventListener("gesturestart", gesture);
      list.removeEventListener("gesturechange", gesture);
    };
  }, [list, on, touch]);

  const anchor = useCallback(() => {
    const a = anchorAt.current;
    return a && performance.now() - a.t < ANCHOR_MS ? a.y : null;
  }, []);
  return { rowH, anchor };
}
