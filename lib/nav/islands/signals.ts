"use client";

/**
 * What the bottom island watches (docs/bottom-nav.md). Every hook is
 * event-driven: scroll, visualViewport resize, focus, online/offline,
 * visibilitychange, a ResizeObserver and a MutationObserver. Nothing polls.
 */
import { type RefObject, useEffect, useState } from "react";
import { debugOn, DEBUG_EVENT } from "@/lib/debug-client";
import { idbAll, idbGet } from "@/lib/words/idb";
import {
  type Box,
  dockAbove,
  dueTotal,
  edgeSwipe,
  keyboardUp,
  nextCompact,
  seenTotal,
} from "../nav-core";
import { setDrawerOpen } from "../ui-store";

/** Debug mode, which is when the Learning Partner chat is on. */
export function useDebugMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => setOn(debugOn());
    read();
    window.addEventListener(DEBUG_EVENT, read);
    return () => window.removeEventListener(DEBUG_EVENT, read);
  }, []);
  return on;
}

/** Shrunk to the capsule: after scrolling down; back on scrolling up, or `idleMs` after it stops. */
export function useCompactOnScroll(idleMs = 1200): [boolean, (v: boolean) => void] {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const last = new WeakMap<EventTarget, number>();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const top = (t: EventTarget) =>
      t === document || t === window ? window.scrollY : ((t as Element).scrollTop ?? 0);
    const onScroll = (e: Event) => {
      const t = e.target ?? document;
      const y = top(t);
      // A scroller seen for the first time started at the top.
      const prev = last.get(t) ?? 0;
      last.set(t, y);
      setCompact((c) => nextCompact(c, y - prev));
      clearTimeout(idle);
      idle = setTimeout(() => setCompact(false), idleMs);
    };
    // Capture: the /words list scrolls in its own fixed element, not the window.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      clearTimeout(idle);
    };
  }, [idleMs]);
  return [compact, setCompact];
}

const editable = (el: Element | null) =>
  !!el &&
  (el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement &&
      !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(
        el.type,
      )) ||
    (el as HTMLElement).isContentEditable);

/** The on-screen keyboard is open: an editable field has focus and the viewport shrank. */
export function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    let tallest = Math.max(window.innerHeight, vv?.height ?? 0);
    const check = () => {
      const h = vv?.height ?? window.innerHeight;
      const focused = editable(document.activeElement);
      if (!focused) tallest = Math.max(tallest, h, window.innerHeight);
      setUp(keyboardUp({ vvHeight: Math.min(h, window.innerHeight), tallest, editable: focused }));
    };
    const rotate = () => {
      tallest = 0;
      check();
    };
    vv?.addEventListener("resize", check);
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", rotate);
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", check);
    return () => {
      vv?.removeEventListener("resize", check);
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", rotate);
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", check);
    };
  }, []);
  return up;
}

const box = (r: DOMRect): Box => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });

/**
 * px above the bottom edge that keep the island clear of the Learning
 * Partner bar (packages/debug-chat), or 0. Follows the bar as it appears,
 * resizes and is dragged.
 */
export function useChatDock(island: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [dock, setDock] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setDock(0);
      return;
    }
    let bar: Element | null = null;
    const ro = new ResizeObserver(() => measure());
    // The bar's box: its style (a drag) and minimized state change on it.
    const moved = new MutationObserver(() => measure());
    const attach = () => {
      const now = document.querySelector("[data-debug-chat-row]");
      if (now === bar) return;
      if (bar) ro.unobserve(bar);
      moved.disconnect();
      bar = now;
      if (bar) {
        ro.observe(bar);
        const section = bar.closest("[data-debug-chat]");
        if (section)
          moved.observe(section, {
            attributes: true,
            attributeFilter: ["style", "data-minimized"],
          });
      }
      measure();
    };
    // The bar appearing or going: cheap, measures only when it changed.
    const mo = new MutationObserver(attach);
    function measure() {
      const el = island.current;
      if (!el) return;
      // The island's resting place: its box with the dock taken off.
      const r = el.getBoundingClientRect();
      const shift = parseFloat(el.dataset.dock ?? "0") || 0;
      const rest = shift ? { ...box(r), top: r.top + shift, bottom: r.bottom + shift } : box(r);
      const b = bar?.getBoundingClientRect();
      setDock(dockAbove(rest, b && b.width ? box(b) : null, window.innerHeight));
    }
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    attach();
    measure();
    return () => {
      ro.disconnect();
      mo.disconnect();
      moved.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [island, enabled]);
  return dock;
}

type CachedList = { due?: number; source?: string | null; cards?: number };

/** Due reviews (cached word lists, then the server once per visit), pending reviews, online. */
export function useNavData(signedIn: boolean, pathname: string) {
  const [due, setDue] = useState(0);
  /** Words seen over the lists; null until a list is known. */
  const [seen, setSeen] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let alive = true;
    const local = async () => {
      const [lists, ops] = await Promise.all([
        idbGet<CachedList[]>("lists", "all").catch(() => undefined),
        idbAll<unknown>("pending").catch(() => [] as unknown[]),
      ]);
      if (!alive) return;
      if (lists) {
        setDue(dueTotal(lists));
        setSeen(seenTotal(lists));
      }
      setPending(ops.length);
    };
    const remote = async () => {
      if (!signedIn || !navigator.onLine) return;
      try {
        const r = await fetch("/api/words/lists", { cache: "no-store" });
        if (!r.ok) return;
        const { lists } = (await r.json()) as { lists?: CachedList[] };
        if (alive && lists) {
          setDue(dueTotal(lists));
          setSeen(seenTotal(lists));
        }
      } catch {}
    };
    const net = () => {
      setOnline(navigator.onLine);
      void local();
    };
    const shown = () => {
      if (document.visibilityState !== "visible") return;
      void local().then(remote);
    };
    setOnline(navigator.onLine);
    void local().then(remote);
    window.addEventListener("online", net);
    window.addEventListener("offline", net);
    document.addEventListener("visibilitychange", shown);
    return () => {
      alive = false;
      window.removeEventListener("online", net);
      window.removeEventListener("offline", net);
      document.removeEventListener("visibilitychange", shown);
    };
    // A route change re-reads the offline copy (a study session updates it).
  }, [signedIn, pathname]);
  return { due, pending, online, seen };
}

/**
 * The /words help strip's text ([data-words-help], app/(app)/words), or null
 * where there is none. The strip stays rendered (hidden under the island on a
 * phone), so its text, already localized and for this input, is read from it.
 */
export function useWordsHint(pathname: string): string | null {
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    let strip: Element | null = null;
    const read = () => setHint(strip?.textContent?.trim() || null);
    const own = new MutationObserver(read);
    const attach = () => {
      const now = document.querySelector("[data-words-help]");
      if (now === strip) return;
      own.disconnect();
      strip = now;
      if (strip) own.observe(strip, { childList: true, subtree: true, characterData: true });
      read();
    };
    // The strip coming and going (the list loads, a short window hides it).
    const mo = new MutationObserver(attach);
    mo.observe(document.body, { childList: true, subtree: true });
    attach();
    return () => {
      mo.disconnect();
      own.disconnect();
    };
  }, [pathname]);
  return hint;
}

/** While mounted on a phone, the /words help strip hides under the island; its text moves to the drawer's "?". */
export function useHideWordsStrip(island: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.navIsland = "hide-words-help";
    // Not display:none: /words measures the strip to pad its list, so it stays
    // in place, invisible, and at least as tall as what the island covers (so
    // no row rests under the island). Click-through: it must never swallow a
    // tap meant for the page; only the capsule itself takes taps.
    style.textContent =
      "@media (max-width: 47.99rem) { [data-words-help] { opacity: 0; pointer-events: none; min-height: var(--lk-island-cover, 0px); } }";
    document.head.append(style);
    const root = document.documentElement;
    const cover = () => {
      const el = island.current;
      // The island's resting top: its box with any dock or shrink transform taken off.
      const top = el?.offsetHeight ? el.getBoundingClientRect().top : null;
      if (top === null) root.style.removeProperty("--lk-island-cover");
      else
        root.style.setProperty(
          "--lk-island-cover",
          `${Math.max(0, Math.round(window.innerHeight - top + 8))}px`,
        );
    };
    const ro = new ResizeObserver(cover);
    if (island.current) ro.observe(island.current);
    window.addEventListener("resize", cover);
    cover();
    return () => {
      style.remove();
      ro.disconnect();
      window.removeEventListener("resize", cover);
      root.style.removeProperty("--lk-island-cover");
    };
  }, [island]);
}

/** A swipe in from the start edge opens the drawer (a phone gesture). */
export function useEdgeSwipe(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const v = edgeSwipe(
        start,
        { x: t.clientX, y: t.clientY },
        {
          width: window.innerWidth,
          // The app's dir is on the layout's wrapper, not <html>.
          rtl:
            getComputedStyle(document.querySelector("main") ?? document.body).direction === "rtl",
        },
      );
      if (v === "wait") return;
      start = null;
      if (v === "open") setDrawerOpen(true);
    };
    const end = () => {
      start = null;
    };
    document.addEventListener("touchstart", down, { passive: true });
    document.addEventListener("touchmove", move, { passive: true });
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", end, { passive: true });
    return () => {
      document.removeEventListener("touchstart", down);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", end);
    };
  }, [enabled]);
}
