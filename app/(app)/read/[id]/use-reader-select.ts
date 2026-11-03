"use client";

// The DOM side of the combo-click selection (lib/read/reader-select.ts holds
// the rules): one delegated listener for the reader, the highlight of the
// selected unit, and the flash a deep link lands with.
//
// - **Clicks.** `pointerdown` timestamps time the combo; the browser's own
//   `click` says it was a click (a swipe to grade or a scroll never makes
//   one). The click's point, not its target, finds the word: the swipe core
//   captures the pointer. Native double/triple-click selection is suppressed
//   in the book (mousedown with detail > 1), so the levels stay ours; a drag
//   to select text is left alone.
// - **Highlight.** Every level is drawn without touching the DOM selection:
//   the CSS Custom Highlight API where there is one (ranges over the rows
//   mounted now), else an attribute on the same elements. A chapter or the
//   book is a virtual selection: the range is data, and only its mounted
//   rows are drawn, again as rows mount (a MutationObserver on the list).

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  type Combo,
  type ComboCtx,
  type Hit,
  type Unit,
  comboClick,
} from "@/lib/read/reader-select";

const HL = "lk-sel";

type Highlights = { set(n: string, h: unknown): void; delete(n: string): void };
const highlights = (): Highlights | null =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
    ? (CSS as unknown as { highlights: Highlights }).highlights
    : null;

/** The elements a unit covers among the rows mounted now. */
export function unitElements(
  root: HTMLElement,
  u: Unit,
  chapterRange: (n: number) => [number, number] | null,
): HTMLElement[] {
  const all = <T extends HTMLElement = HTMLElement>(sel: string) => [
    ...root.querySelectorAll<T>(sel),
  ];
  switch (u.kind) {
    case "word":
      return all(`[data-line="${u.line}"] [data-t="${u.t}"]`);
    case "phrase":
      return all(`[data-line="${u.line}"] [data-t]`).filter((e) => {
        const t = Number(e.dataset.t);
        return t >= u.t0 && t <= u.t1;
      });
    case "sentence":
      return all(`[data-line="${u.line}"] [data-s="${u.s}"]`);
    case "para":
      return all(`[data-line="${u.line}"]`);
    case "chapter": {
      const r = chapterRange(u.n);
      if (!r) return [];
      return all("[data-line]").filter((e) => {
        const l = Number(e.dataset.line);
        return l >= r[0] && l < r[1];
      });
    }
    case "book":
      return all("[data-line]");
  }
}

/** Ranges for the highlight: whole elements; a phrase from its first word to its last, per paragraph. */
function rangesOf(u: Unit, els: HTMLElement[]): Range[] {
  if (u.kind !== "phrase") {
    return els.map((e) => {
      const r = document.createRange();
      r.selectNodeContents(e);
      return r;
    });
  }
  const byPara = new Map<Element, HTMLElement[]>();
  for (const e of els) {
    const p = e.closest("[data-line]");
    if (!p) continue;
    const list = byPara.get(p) ?? [];
    list.push(e);
    byPara.set(p, list);
  }
  return [...byPara.values()].map((list) => {
    const r = document.createRange();
    r.setStartBefore(list[0]);
    r.setEndAfter(list[list.length - 1]);
    return r;
  });
}

/** What a click at (x, y) landed on in the book, or null (a margin, the rail, outside). */
export function hitAt(root: HTMLElement, x: number, y: number): Hit | null {
  const el = document.elementFromPoint(x, y);
  if (!el || !root.contains(el)) return null;
  const p = el.closest<HTMLElement>("[data-line]");
  if (!p || !root.contains(p)) return null;
  const s = el.closest<HTMLElement>("[data-s]");
  const t = el.closest<HTMLElement>("[data-t]");
  return {
    line: Number(p.dataset.line),
    s: s && p.contains(s) ? Number(s.dataset.s) : null,
    t: t && p.contains(t) ? Number(t.dataset.t) : null,
  };
}

export interface ReaderSelect {
  unit: Unit | null;
  /** Select a unit (a deep link, a program): `flash` marks it once it is on screen. */
  select: (u: Unit, o?: { flash?: boolean }) => void;
  clear: () => void;
  /** The selection was made in the lower half of the screen: the card goes to the top. */
  low: boolean;
}

export function useReaderSelect(o: {
  listRef: RefObject<HTMLDivElement | null>;
  ctx: ComboCtx;
  /** A fling is still moving: a tap then stops it, it selects nothing. */
  scrolling: () => boolean;
}): ReaderSelect {
  const [unit, setUnit] = useState<Unit | null>(null);
  const [low, setLow] = useState(false);
  const combo = useRef<Combo | null>(null);
  const ctxRef = useRef(o.ctx);
  ctxRef.current = o.ctx;
  const scrollingRef = useRef(o.scrolling);
  scrollingRef.current = o.scrolling;
  const flash = useRef(false);
  const placed = useRef(false);

  const clear = useCallback(() => {
    combo.current = null;
    setUnit(null);
  }, []);
  const select = useCallback((u: Unit, opt?: { flash?: boolean }) => {
    combo.current = { unit: u, at: -Infinity };
    flash.current = !!opt?.flash;
    placed.current = false;
    setUnit(u);
  }, []);

  // One delegated listener set for the reader.
  useEffect(() => {
    let downAt = 0;
    const inBook = (n: EventTarget | null) => n instanceof Node && !!o.listRef.current?.contains(n);
    const down = (e: PointerEvent) => {
      if (e.isPrimary && e.button === 0) downAt = e.timeStamp;
    };
    const mouse = (e: MouseEvent) => {
      // The platform's own double/triple-click selection: ours instead.
      if (e.detail > 1 && inBook(e.target)) e.preventDefault();
    };
    const click = (e: MouseEvent) => {
      const root = o.listRef.current;
      if (!root) return;
      const target = e.target as Element | null;
      if (target?.closest?.("[data-select-card]")) return;
      const hit = inBook(target) || root.contains(document.elementFromPoint(e.clientX, e.clientY));
      if (!hit) {
        // A tap elsewhere clears the selection.
        if (combo.current) clear();
        return;
      }
      if (scrollingRef.current()) return;
      const sel = window.getSelection();
      // He dragged to select text himself: leave it to the browser.
      if (sel && !sel.isCollapsed && e.detail <= 1) return;
      const h = hitAt(root, e.clientX, e.clientY);
      if (!h) {
        if (combo.current) clear();
        return;
      }
      const next = comboClick(combo.current, h, downAt || e.timeStamp, ctxRef.current);
      combo.current = next;
      if (e.detail > 1) sel?.removeAllRanges();
      flash.current = false;
      // The card takes the other half of the screen from his finger, so the
      // next click of the combo lands on the book, never on the card.
      placed.current = true;
      setLow(e.clientY > innerHeight / 2);
      setUnit(next.unit);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("mousedown", mouse, true);
    document.addEventListener("click", click);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("mousedown", mouse, true);
      document.removeEventListener("click", click);
    };
  }, [o.listRef, clear]);

  // The highlight, redrawn as rows mount and unmount.
  useEffect(() => {
    const root = o.listRef.current;
    const hl = highlights();
    let marked: HTMLElement[] = [];
    const wipe = () => {
      hl?.delete(HL);
      for (const e of marked) e.removeAttribute("data-sel");
      marked = [];
    };
    if (!root || !unit) {
      wipe();
      return;
    }
    let frame = 0;
    const paint = () => {
      frame = 0;
      const els = unitElements(root, unit, (n) => ctxRef.current.chapterRange(n));
      wipe();
      if (hl) {
        const H = Highlight as unknown as new (...r: Range[]) => unknown;
        hl.set(HL, new H(...rangesOf(unit, els)));
      } else {
        for (const e of els) e.setAttribute("data-sel", "");
        marked = els;
      }
      if (!els.length) return;
      if (!placed.current) {
        placed.current = true;
        // A link's unit: the card keeps clear of where it starts.
        const r = els[0].getBoundingClientRect();
        setLow(unit.kind !== "chapter" && unit.kind !== "book" && r.top > innerHeight / 2);
      }
      if (flash.current) {
        flash.current = false;
        // The unit itself, or for a chapter or the book its first rows on screen.
        const f = unit.kind === "chapter" || unit.kind === "book" ? els.slice(0, 3) : els;
        for (const e of f) {
          e.removeAttribute("data-flash");
          void e.offsetWidth;
          e.setAttribute("data-flash", "");
          e.addEventListener("animationend", () => e.removeAttribute("data-flash"), {
            once: true,
          });
        }
      }
    };
    paint();
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(paint);
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(frame);
      wipe();
    };
  }, [unit, o.listRef]);

  return { unit, select, clear, low };
}
