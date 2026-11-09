"use client";

/**
 * How many of the rail's links move into its "⋯" popover so that nothing is
 * cut off (owner, 2026-11-09: "left side panel 太高了"). Measured, not set by
 * breakpoints: after every render, while the link list overflows its box, one
 * more link (the last one first) moves out; a new viewport size or a change in
 * the rows above the links starts over from none. It converges before paint
 * (layout effects), a link at a time.
 *
 * The budget is the rail's height with the top bar in view, the shortest it
 * gets: on a desktop the rail is sticky and grows by the top bar's height as
 * that scrolls away, and counting that would move links in and out of "⋯"
 * while scrolling. Only when even the first group cannot fit does the list
 * scroll (the last resort, .lk-rail-scroll).
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

export function useRailFit({
  rail,
  list,
  rows,
  header,
  movable,
  enabled,
  resetKey,
}: {
  /** The rail column: the list, "⋯" and the foot. */
  rail: RefObject<HTMLElement | null>;
  /** The scrollable link list inside it. */
  list: RefObject<HTMLElement | null>;
  /** The rows above the links (pins, recent pages), whose height changes on its own. */
  rows: RefObject<HTMLElement | null>;
  header: RefObject<HTMLElement | null>;
  /** How many links may move out (all but the first group). */
  movable: number;
  enabled: boolean;
  /** Anything else that changes the list's height (collapsed, the items shown). */
  resetKey: string;
}): number {
  const [hidden, setHidden] = useState(0);
  const [epoch, setEpoch] = useState(0);

  // Start over from none when the room or the content changes.
  useLayoutEffect(() => setHidden(0), [resetKey, epoch, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const again = () => setEpoch((e) => e + 1);
    window.addEventListener("resize", again);
    const ro = new ResizeObserver(again);
    if (rows.current) ro.observe(rows.current);
    return () => {
      window.removeEventListener("resize", again);
      ro.disconnect();
    };
  }, [enabled, rows]);

  // After every render: still overflowing, and something left to move? Move one.
  useLayoutEffect(() => {
    const el = list.current;
    const box = rail.current;
    // A phone: the rail is not shown (display: none), there is nothing to fit.
    if (!enabled || !el || !box || hidden >= movable || !box.clientHeight) return;
    if (contentHeight(el) > el.clientHeight - slack(box, header.current) + 0.5)
      setHidden(hidden + 1);
  });

  return enabled ? hidden : 0;
}

/**
 * The list's content height. Not scrollHeight: that is never less than the
 * box, which grows (flex) while the top bar scrolls away.
 */
function contentHeight(el: HTMLElement): number {
  const last = el.lastElementChild;
  if (!last) return 0;
  const pad = parseFloat(getComputedStyle(el).paddingBottom) || 0;
  return last.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop + pad;
}

/** How much taller the rail is now than with the top bar in view (0 on a tablet, whose rail is fixed). */
function slack(rail: HTMLElement, header: HTMLElement | null): number {
  if (!header) return 0;
  const headerBottomAtTop = header.getBoundingClientRect().bottom + window.scrollY;
  const shortest = window.innerHeight - headerBottomAtTop;
  return Math.max(0, rail.getBoundingClientRect().height - shortest);
}

/**
 * A ref callback for a scrolling link list: marks the edges that have more
 * beyond them (data-more-above / data-more-below), which .lk-rail-scroll fades.
 */
export function edgeFade(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return;
  const mark = () => {
    el.toggleAttribute("data-more-above", el.scrollTop > 1);
    el.toggleAttribute("data-more-below", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };
  mark();
  el.addEventListener("scroll", mark, { passive: true });
  const ro = new ResizeObserver(mark);
  ro.observe(el);
  // Links moving in and out of "⋯", the rows above them changing.
  const mo = new MutationObserver(mark);
  mo.observe(el, { childList: true, subtree: true });
  return () => {
    el.removeEventListener("scroll", mark);
    ro.disconnect();
    mo.disconnect();
  };
}
