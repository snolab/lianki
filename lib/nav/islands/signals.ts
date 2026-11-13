"use client";

/**
 * What the bottom island watches (docs/bottom-nav.md). Every hook is
 * event-driven: scroll, visualViewport resize, focus, online/offline,
 * visibilitychange, a ResizeObserver and a MutationObserver. Nothing polls.
 */
import { type RefObject, useEffect, useState } from "react";
import { debugOn, DEBUG_EVENT } from "@/lib/debug-client";
import { idbAll, idbGet } from "@/lib/words/idb";
import { CHAT_VIEWER_ATTR, partnerEntryShown, readChatViewer } from "@/lib/partner-entry";
import {
  type Box,
  CHAT_MOVED_EVENT,
  chatFootprint,
  type DockCause,
  dockAbove,
  redocks,
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

/**
 * The "Learning Partner" row is shown (lib/partner-entry.ts): a partner user
 * on every page, any other signed-in user in debug mode; a guest never. The
 * viewer comes from `<html data-chat-viewer>`, set by the root layout.
 */
export function usePartnerEntry(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () =>
      setOn(
        partnerEntryShown(
          readChatViewer(document.documentElement.getAttribute(CHAT_VIEWER_ATTR)),
          debugOn(),
        ),
      );
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

/**
 * `--lk-bottom-reserve` on <html>: what the island covers at rest (its own
 * height, never its dock or the chat's state), for <main>'s bottom padding
 * and the chat bar's resting place above it.
 */
export function useBottomReserve(island: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = island.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => {
      const h = el.offsetHeight; // 0 while display:none (tablet and up)
      if (h)
        root.style.setProperty(
          "--lk-bottom-reserve",
          `calc(${h + 16}px + env(safe-area-inset-bottom))`,
        );
      else root.style.removeProperty("--lk-bottom-reserve");
    };
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => {
      ro.disconnect();
      root.style.removeProperty("--lk-bottom-reserve");
    };
  }, [island]);
}

const box = (r: DOMRect): Box => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });

/**
 * px above the bottom edge that keep the island clear of the Learning
 * Partner bar (packages/debug-chat), or 0. Decided only when the bar appears,
 * when a drag of it ends (CHAT_MOVED_EVENT) and on a rotation (`redocks`):
 * minimizing, expanding, a growing draft or the keyboard never move the
 * island. The bar's footprint is the chat box's width, so the answer is the
 * same expanded or minimized.
 */
export function useChatDock(island: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [dock, setDock] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setDock(0);
      return;
    }
    let section: Element | null = null;
    let width = window.innerWidth;
    function measure(cause: DockCause) {
      if (!redocks(cause)) return;
      const el = island.current;
      if (!el) return;
      // The island's resting place: its box with the dock taken off.
      const r = el.getBoundingClientRect();
      const shift = parseFloat(el.dataset.dock ?? "0") || 0;
      const rest = shift ? { ...box(r), top: r.top + shift, bottom: r.bottom + shift } : box(r);
      const row = section?.querySelector("[data-debug-chat-row]")?.getBoundingClientRect();
      const s = section?.getBoundingClientRect();
      const lift = parseFloat((section as HTMLElement | null)?.dataset.kbLift ?? "0") || 0;
      const bar = row && s && row.width ? chatFootprint(box(row), box(s), lift) : null;
      setDock(dockAbove(rest, bar, window.innerHeight));
    }
    // The chat box appearing or going: cheap, measures only when it changed.
    const attach = () => {
      const now = document.querySelector("[data-debug-chat]");
      if (now === section) return;
      section = now;
      measure("appear");
    };
    const mo = new MutationObserver(attach);
    const moved = () => measure("drag");
    // Only a width change is a rotation: Android's keyboard shrinks the height.
    const resize = () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      measure("rotate");
    };
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener(CHAT_MOVED_EVENT, moved);
    window.addEventListener("resize", resize);
    attach();
    measure("appear");
    return () => {
      mo.disconnect();
      window.removeEventListener(CHAT_MOVED_EVENT, moved);
      window.removeEventListener("resize", resize);
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
