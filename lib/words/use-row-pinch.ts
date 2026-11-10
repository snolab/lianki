"use client";

/**
 * The /words list's pinch for card height (lib/words/row-pinch.ts holds the
 * maths). Two fingers on the list, moved apart or together vertically, set
 * every row's height; the rows follow the fingers, and on lifting settle on a
 * whole line (no animation with motion off). The choice is the synced pref
 * `words.cardHeight` (docs/prefs-sync.md), written once, when the pinch ends.
 *
 * Why the list shook (owner, iPhone, 2026-11-10): every frame of the pinch
 * was a React state change, so the whole list re-rendered 60 times a second,
 * and the scroll that kept the fingers' row in place was written while iOS
 * was still panning the list natively (a pinch is two fingers that also
 * pan; once a pan has started, WebKit ignores preventDefault) — the two
 * fought each frame. Now:
 *
 * - The height is one CSS variable, `--row-h` on the list, written in a
 *   requestAnimationFrame; rows, spacers and cords read it. React hears of a
 *   pinch only when the row crosses a whole line (the back cells' line
 *   clamps), a few renders per pinch, never per frame.
 * - The row under the fingers' midpoint is the anchor, by its index, for the
 *   whole pinch: each frame, after the new height, the scroll puts that row's
 *   point back under the fingers (one layout read, one scroll write).
 * - While two fingers are down the list does not scroll natively
 *   (`.lk-pinching`: overflow hidden, touch-action none), so only the anchor
 *   moves the scroll. `overflow-anchor` stays none on the list: the browser's
 *   own scroll anchoring would pick some other row and shift it again.
 * - The height follows the fingers at a low gain, past a small dead zone, eased
 *   (PinchFeel, config keys words.pinchGainPct / pinchDeadZonePct / pinchSmoothMs).
 *
 * The page never zooms: two-finger touchmoves are cancelled and Safari's own
 * `gesturestart` too. One finger is the swipe's as before: a second finger
 * cancels the row gestures the fingers started (a pointercancel on their
 * rows), so a pinch never grades, taps or reads aloud.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { notePrefWrite, PREF_APPLIED_EVENT } from "@lianki/ui-state";
import { publicCfg } from "@/lib/config-client";
import { motionOff } from "@/lib/motion-pref";
import { ROW_LINE_LH } from "@/lib/words/row-layout";
import {
  anchoredScroll,
  anchorFrac,
  asFactor,
  backAvail,
  CARD_HEIGHT_KEY,
  easeToward,
  minJerk,
  pinchBounds,
  pinchHeight,
  rowHeightFor,
  settleHeight,
  toFactor,
  verticalSpan,
  type PinchFeel,
  type RowNeed,
} from "@/lib/words/row-pinch";

/** The settle's length, ms: the swipe's own settle is of this order. */
const SETTLE_MS = 180;
/** The class the list wears while a pinch holds its scroll (app/globals.css). */
export const PINCHING_CLASS = "lk-pinching";
/** The row-height variable on the list (rows, spacers and cords read it). */
export const ROW_H_VAR = "--row-h";

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

/** The live feel (docs/config-store.md), read when a pinch starts. */
function feelNow(): { feel: PinchFeel; tau: number } {
  return {
    feel: {
      gain: publicCfg("words.pinchGainPct") / 100,
      deadZone: publicCfg("words.pinchDeadZonePct") / 100,
    },
    tau: publicCfg("words.pinchSmoothMs"),
  };
}

/** The row at `y` on screen, or the nearest one rendered. */
function rowAt(list: HTMLElement, y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let gap = Infinity;
  for (const row of list.querySelectorAll<HTMLElement>("[data-i]")) {
    const r = row.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < gap) {
      gap = d;
      best = row;
      if (d === 0) break;
    }
  }
  return best;
}

export interface RowPinch {
  /**
   * The rows' height for React: at rest, the stored one; during a pinch, the
   * height when the row last crossed a whole line (the list's `--row-h` is
   * the live one).
   */
  rowH: number;
  /**
   * Whether the pinch already placed the list for row height `h`: true while
   * fingers are down or it settles, and for the height it settled on. The
   * page's own keep-the-top-row correction must then leave the scroll alone.
   */
  owns: (h: number) => boolean;
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
  /** The height React lays the rows out with during a pinch (per whole line); null at rest. */
  const [live, setLive] = useState<number | null>(null);
  const rowH = on ? (live ?? rowHeightFor(defaultH, factor)) : defaultH;
  const now = useRef(rowH);
  now.current = rowH;
  const opts = useRef({ k, touch, defaultH });
  opts.current = { k, touch, defaultH };
  /** A pinch or its settle is placing the list. */
  const active = useRef(false);
  /** The height the pinch last laid out itself (the settled one, once it ends). */
  const placed = useRef<number | null>(null);
  /** Re-applies the live height after a React render mid-pinch. */
  const reapply = useRef<(() => void) | null>(null);

  // React's height reaches the variable, except while a pinch holds it.
  useLayoutEffect(() => {
    if (!list) return;
    if (active.current) reapply.current?.();
    else list.style.setProperty(ROW_H_VAR, `${rowH}px`);
  }, [list, rowH]);

  useEffect(() => {
    if (!list || !on || !touch) return;
    let p: {
      startH: number;
      span: number;
      bounds: { min: number; max: number };
      /** Where the fingers ask the height to be. */
      target: number;
      /** The height laid out (eased toward `target`). */
      h: number;
      /** The anchor row's index and where on it the fingers are. */
      at: number;
      frac: number;
      midY: number;
      feel: PinchFeel;
      tau: number;
      frame: number;
      last: number;
    } | null = null;
    let tween = 0;
    /** The anchor of the pinch that is settling (p is gone by then). */
    let hold: { at: number; frac: number; midY: number } | null = null;
    /** The line count React last laid the rows out for. */
    let lines = -1;
    const floor = () => opts.current.defaultH / 2;
    const ys = (t: TouchList): [number, number] => [t[0].clientY, t[1].clientY];
    const mid = (t: TouchList) => (t[0].clientY + t[1].clientY) / 2;
    const anchorRow = (at: number) => list.querySelector<HTMLElement>(`[data-i="${at}"]`);

    /** Lays the rows out at `h` and puts the anchor row back under the fingers. */
    const apply = (h: number, a: { at: number; frac: number; midY: number } | null) => {
      list.style.setProperty(ROW_H_VAR, `${h}px`);
      placed.current = h;
      const row = a && anchorRow(a.at);
      if (row && a) {
        const top = row.getBoundingClientRect().top;
        const want = anchoredScroll(list.scrollTop, top, h, a.frac, a.midY);
        if (Math.abs(want - list.scrollTop) >= 0.5) list.scrollTop = want;
      }
      // React re-renders the rows only when they gain or lose a whole line.
      const { k: kk, touch: tt } = opts.current;
      const n = backAvail(h, kk, tt);
      if (n !== lines) {
        lines = n;
        setLive(h);
      }
    };
    reapply.current = () => {
      if (p) apply(p.h, p);
      else if (hold && placed.current !== null) apply(placed.current, hold);
    };

    const frame = (t: number) => {
      if (!p) return;
      const dt = p.last ? t - p.last : 16;
      p.last = t;
      p.h = easeToward(p.h, p.target, dt, p.tau);
      apply(p.h, p);
      p.frame = p.h === p.target ? 0 : requestAnimationFrame(frame);
    };
    const kick = () => {
      if (p && !p.frame) {
        p.last = 0;
        p.frame = requestAnimationFrame(frame);
      }
    };

    const start = (e: TouchEvent) => {
      if (e.touches.length !== 2 || p) return;
      cancelAnimationFrame(tween);
      hold = null;
      // The rows the fingers came down on drop their gesture: no grade, tap or hold.
      for (const t of Array.from(e.touches))
        t.target.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
      // A settle cut short starts from where it was laid out.
      const startH = active.current && placed.current !== null ? placed.current : now.current;
      const { k: kk, touch: tt } = opts.current;
      const midY = mid(e.touches);
      const row = rowAt(list, midY);
      const r = row?.getBoundingClientRect();
      const { feel, tau } = feelNow();
      active.current = true;
      lines = backAvail(startH, kk, tt);
      // Native scrolling stops here: only the anchor moves the list now.
      list.classList.add(PINCHING_CLASS);
      p = {
        startH,
        span: verticalSpan(ys(e.touches), floor()),
        bounds: pinchBounds(measureNeeds(list), kk, tt, startH),
        target: startH,
        h: startH,
        at: row ? Number(row.dataset.i) : -1,
        frac: r ? anchorFrac(midY, r.top, r.height) : 0,
        midY,
        feel,
        tau,
        frame: 0,
        last: 0,
      };
    };
    const move = (e: TouchEvent) => {
      if (!p || e.touches.length < 2) return;
      if (e.cancelable) e.preventDefault();
      p.target = pinchHeight(
        p.startH,
        p.span,
        verticalSpan(ys(e.touches), floor()),
        p.bounds,
        p.feel,
      );
      // The row stays under the fingers: they may drift while they pinch.
      p.midY = mid(e.touches);
      kick();
    };
    const finish = (h: number) => {
      const { defaultH: d } = opts.current;
      const f = toFactor(h, d);
      // React's own height for the factor (whole px): laid out here, so its
      // render changes nothing on screen.
      const final = rowHeightFor(d, f);
      apply(final, hold);
      try {
        localStorage.setItem(CARD_HEIGHT_KEY, String(f));
      } catch {}
      notePrefWrite();
      active.current = false;
      hold = null;
      list.classList.remove(PINCHING_CLASS);
      setFactor(f);
      setLive(null);
    };
    const end = (e: TouchEvent) => {
      if (!p || e.touches.length >= 2) return;
      const done = p;
      p = null;
      cancelAnimationFrame(done.frame);
      hold = { at: done.at, frac: done.frac, midY: done.midY };
      const { k: kk, touch: tt, defaultH: d } = opts.current;
      // Where the fingers asked for, to the nearest whole line.
      const to = settleHeight(done.target, kk, tt, d, done.bounds);
      // Motion off: no settle, just the new height.
      if (motionOff() || Math.abs(to - done.h) < 0.5) return finish(to);
      const from = done.h;
      const t0 = performance.now();
      const step = () => {
        const x = (performance.now() - t0) / SETTLE_MS;
        if (x >= 1) return finish(to);
        apply(from + (to - from) * minJerk(x), hold);
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
      p = null;
      hold = null;
      active.current = false;
      reapply.current = null;
      list.classList.remove(PINCHING_CLASS);
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

  const owns = useCallback((h: number) => {
    if (active.current) return true;
    // The settled height, once: a later change to the same height (text size) is the page's.
    if (placed.current === null || Math.abs(placed.current - h) >= 0.01) return false;
    placed.current = null;
    return true;
  }, []);
  return { rowH, owns };
}
