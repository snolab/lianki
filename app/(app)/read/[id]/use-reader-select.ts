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
//   the CSS Custom Highlight API where there is one and it keeps each word's
//   underline colour (keepsDecorations; ranges over the rows mounted now),
//   else an attribute on the same elements. A chapter or the
//   book is a virtual selection: the range is data, and only its mounted
//   rows are drawn, again as rows mount (a MutationObserver on the list).
// - **Manual selection.** His own selection (a long-press and the handles, a
//   mouse drag) is left to the browser: never moved, never cleared while he
//   adjusts it. Once it settles — `selectionchange` quiet for SETTLE_MS with
//   no pointer down, or a pointerup — it is snapped to whole words
//   (snapIndices) and becomes a `range` unit with the same card, which takes
//   the side of the screen with more room than the selection leaves, away
//   from the native handles and menu. A tap elsewhere (also in the book)
//   clears it; a tap on the card keeps it even if the platform drops the
//   native selection.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  CHAT_SELECTOR,
  type Combo,
  type ComboCtx,
  type Hit,
  type Unit,
  comboClick,
  comboContinues,
  inChat,
  inRange,
  rangeUnit,
  sameUnit,
  snapIndices,
} from "@/lib/read/reader-select";

/** A hand selection has settled once `selectionchange` is this quiet (ms). */
export const SETTLE_MS = 350;

const HL = "lk-sel";

type Highlights = { set(n: string, h: unknown): void; delete(n: string): void };
const highlights = (): Highlights | null =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
    ? (CSS as unknown as { highlights: Highlights }).highlights
    : null;

let keeps: boolean | null = null;
/**
 * Whether this engine paints the underlines inside `::highlight(lk-sel)` in
 * each word's own colour (globals.css: `text-decoration-color: inherit`).
 * WebKit takes the inherited colour from the word, so the familiarity levels
 * stay apart; Chromium takes it from the parent highlight, one colour for all
 * (owner, 2026-11-05). Asked once, of the engine's own computed style: a probe
 * with a known underline colour, read through the highlight pseudo. An engine
 * that cannot answer (no pseudo, no background from the rule) counts as no;
 * asked again while the page is still loading.
 */
export function keepsDecorations(): boolean {
  if (keeps !== null) return keeps;
  try {
    const probe = document.createElement("span");
    probe.textContent = "x";
    probe.style.cssText =
      "position:absolute;opacity:0;pointer-events:none;text-decoration:underline solid oklch(0.5 0.1 30)";
    document.body.appendChild(probe);
    const own = getComputedStyle(probe).textDecorationColor;
    // A live declaration: read before the probe goes.
    const hl = getComputedStyle(probe, `::highlight(${HL})`);
    const bg = hl.backgroundColor;
    const deco = hl.textDecorationColor;
    probe.remove();
    // No background: the engine cannot read the pseudo, or the stylesheet is
    // still loading (then ask again next time).
    if (!bg || bg === "rgba(0, 0, 0, 0)") {
      keeps = document.readyState === "complete" ? false : null;
      return false;
    }
    keeps = deco === own;
  } catch {
    keeps = false;
  }
  return keeps;
}

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
    case "range":
      return all("[data-line] [data-t]").filter((e) =>
        inRange(
          u,
          Number(e.closest<HTMLElement>("[data-line]")!.dataset.line),
          Number(e.dataset.t),
        ),
      );
  }
}

/** The unit a native selection covers, snapped to whole words; null when it holds none. */
export function snapDomRange(root: HTMLElement, r: Range): Unit | null {
  const toks = [...root.querySelectorAll<HTMLElement>("[data-line] [data-t]")];
  const probe = document.createRange();
  // A range that would end before it starts collapses: empty, so false.
  const has = (sn: Node, so: number, en: Node, eo: number) => {
    probe.setStart(sn, so);
    probe.setEnd(en, eo);
    return probe.toString().length > 0;
  };
  const ij = snapIndices(
    toks.length,
    (i) => has(r.startContainer, r.startOffset, toks[i], toks[i].childNodes.length),
    (i) => has(toks[i], 0, r.endContainer, r.endOffset),
  );
  if (!ij) return null;
  const ref = (e: HTMLElement) => ({
    line: Number(e.closest<HTMLElement>("[data-line]")!.dataset.line),
    t: Number(e.dataset.t),
  });
  return rangeUnit(ref(toks[ij[0]]), ref(toks[ij[1]]));
}

/** Ranges for the highlight: whole elements; a phrase from its first word to its last, per paragraph. */
function rangesOf(u: Unit, els: HTMLElement[]): Range[] {
  if (u.kind === "range") {
    // One range from its first mounted word to its last, across paragraphs.
    if (!els.length) return [];
    const r = document.createRange();
    r.setStartBefore(els[0]);
    r.setEndAfter(els[els.length - 1]);
    return [r];
  }
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
  /** The unit is his own native selection, snapped to words. */
  manual: boolean;
}

export function useReaderSelect(o: {
  listRef: RefObject<HTMLDivElement | null>;
  ctx: ComboCtx;
  /** A fling is still moving: a tap then stops it, it selects nothing. */
  scrolling: () => boolean;
  /**
   * A click of the combo selected `unit`; `continued`: it carried the last
   * click's combo on. Called inside the click, so a voice started here has
   * the gesture.
   */
  onTap?: (unit: Unit, continued: boolean) => void;
}): ReaderSelect {
  const [unit, setUnit] = useState<Unit | null>(null);
  const [low, setLow] = useState(false);
  const combo = useRef<Combo | null>(null);
  const ctxRef = useRef(o.ctx);
  ctxRef.current = o.ctx;
  const scrollingRef = useRef(o.scrolling);
  scrollingRef.current = o.scrolling;
  const onTapRef = useRef(o.onTap);
  onTapRef.current = o.onTap;
  const flash = useRef(false);
  const placed = useRef(false);
  /** The unit came from his native selection. */
  const manual = useRef(false);
  const [isManual, setManual] = useState(false);
  const unitRef = useRef<Unit | null>(null);
  unitRef.current = unit;

  const clear = useCallback(() => {
    combo.current = null;
    if (manual.current) {
      // Closed by hand (×, Esc, back): his selection goes with the card.
      const s = window.getSelection();
      if (s && !s.isCollapsed) s.removeAllRanges();
    }
    manual.current = false;
    setManual(false);
    setUnit(null);
  }, []);
  const select = useCallback((u: Unit, opt?: { flash?: boolean }) => {
    combo.current = { unit: u, at: -Infinity };
    flash.current = !!opt?.flash;
    placed.current = false;
    manual.current = false;
    setManual(false);
    setUnit(u);
  }, []);

  // One delegated listener set for the reader.
  useEffect(() => {
    let downAt = 0;
    /** Pointers down now: a selection is not settled while one is. */
    const pressed = new Set<number>();
    /** The last press was on the card: the native selection may go, the card stays. */
    let onCard = false;
    let settleT: ReturnType<typeof setTimeout> | undefined;
    const inBook = (n: EventTarget | null) => n instanceof Node && !!o.listRef.current?.contains(n);
    const settle = () => {
      clearTimeout(settleT);
      if (pressed.size) return;
      const root = o.listRef.current;
      const s = window.getSelection();
      if (!root || !s || s.rangeCount === 0 || s.isCollapsed) {
        // His selection went (a tap elsewhere): its card goes too.
        if (manual.current && !onCard) clear();
        return;
      }
      const r = s.getRangeAt(0);
      // A selection in the card or the chrome, not in the book: not ours.
      if (!r.intersectsNode(root)) return;
      // A selection that starts in the chat (copying a message) is the chat's.
      if (s.anchorNode?.parentElement?.closest(CHAT_SELECTOR)) return;
      if (s.anchorNode instanceof Node && s.anchorNode.parentElement?.closest("[data-select-card]"))
        return;
      const u = snapDomRange(root, r);
      if (!u) {
        // Moved onto spaces or punctuation only: no words, so no card (his selection stays).
        if (manual.current) {
          combo.current = null;
          manual.current = false;
          setManual(false);
          setUnit(null);
        }
        return;
      }
      if (sameUnit(u, unitRef.current)) {
        // The unit on the card already (a word he tapped, now selected by hand): his now.
        manual.current = true;
        setManual(true);
        return;
      }
      combo.current = { unit: u, at: -Infinity };
      flash.current = false;
      placed.current = true;
      manual.current = true;
      setManual(true);
      // The card takes the side the selection leaves more room on.
      const b = r.getBoundingClientRect();
      setLow(b.top > innerHeight - b.bottom);
      setUnit(u);
    };
    const later = (ms: number) => {
      clearTimeout(settleT);
      settleT = setTimeout(settle, ms);
    };
    const selChange = () => later(SETTLE_MS);
    const down = (e: PointerEvent) => {
      // A new gesture: any pointer whose end was missed is gone.
      if (e.isPrimary) pressed.clear();
      pressed.add(e.pointerId);
      onCard = e.target instanceof Element && !!e.target.closest("[data-select-card]");
      if (e.isPrimary && e.button === 0) downAt = e.timeStamp;
    };
    const up = (e: PointerEvent) => {
      pressed.delete(e.pointerId);
      // A drag ends with the selection made: settle at once.
      if (!pressed.size) later(30);
    };
    const mouse = (e: MouseEvent) => {
      // The platform's own double/triple-click selection: ours instead.
      if (e.detail > 1 && inBook(e.target)) e.preventDefault();
    };
    const click = (e: MouseEvent) => {
      const root = o.listRef.current;
      if (!root) return;
      // The chat over the book (its copy button, a tap on its text): not the
      // reader's tap, and it must not clear what is selected there.
      if (inChat(e)) return;
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
      // A tap on the book while his own selection's card is up: it clears.
      if (manual.current) {
        clear();
        return;
      }
      const h = hitAt(root, e.clientX, e.clientY);
      if (!h) {
        if (combo.current) clear();
        return;
      }
      const at = downAt || e.timeStamp;
      const continued = comboContinues(combo.current, h, at, ctxRef.current);
      const next = comboClick(combo.current, h, at, ctxRef.current);
      combo.current = next;
      onTapRef.current?.(next.unit, continued);
      if (e.detail > 1) sel?.removeAllRanges();
      flash.current = false;
      manual.current = false;
      setManual(false);
      // The card takes the other half of the screen from his finger, so the
      // next click of the combo lands on the book, never on the card.
      placed.current = true;
      setLow(e.clientY > innerHeight / 2);
      setUnit(next.unit);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("selectionchange", selChange);
    document.addEventListener("mousedown", mouse, true);
    document.addEventListener("click", click);
    return () => {
      clearTimeout(settleT);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("selectionchange", selChange);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("mousedown", mouse, true);
      document.removeEventListener("click", click);
    };
  }, [o.listRef, clear]);

  // The highlight, redrawn as rows mount and unmount.
  useEffect(() => {
    const root = o.listRef.current;
    // Where the highlight would recolour the underlines, the elements carry it.
    const hl = highlights() && keepsDecorations() ? highlights() : null;
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

  return { unit, select, clear, low, manual: isManual };
}
