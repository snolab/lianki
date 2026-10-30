"use client";

/**
 * The bottom island navigation (docs/bottom-nav.md): a floating glass
 * capsule fixed at the bottom of a phone screen. Home, Menu (the drawer),
 * the centre button (the Learning Partner in debug mode, else Create; a long
 * press is always Create) and Search (the command palette, also Ctrl/⌘ K).
 *
 * It shrinks to a small capsule on scrolling down and comes back on scrolling
 * up or when scrolling stops, hides while the on-screen keyboard is open,
 * docks above the chat bar and reserves its height for the page
 * (--lk-bottom-reserve). Phones only; the palette works everywhere.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/app/components/icons";
import type { IslandProps } from "@/lib/islands/contract";
import { useUi } from "@lianki/ui-state";
import { badge, fill, showFirstTip } from "../nav-core";
import { navTip, navUi, noteVisit, setDrawerOpen } from "../ui-store";
import { CreateSheet } from "./CreateSheet";
import { SearchPalette } from "./SearchPalette";
import {
  useChatDock,
  useCompactOnScroll,
  useDebugMode,
  useEdgeSwipe,
  useKeyboardUp,
  useHideWordsStrip,
  useNavData,
  useWordsHint,
} from "./signals";
import { useNavText } from "./text";

/** Haptics where the device has them (Android); a no-op elsewhere. */
const tick = () => {
  try {
    navigator.vibrate?.(12);
  } catch {}
};

export function BottomIsland({ signedIn }: IslandProps["nav.bottom"]) {
  const t = useNavText();
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const debug = useDebugMode();
  const drawerOpen = useUi(navUi, (s) => s.drawerOpen);
  const [sheet, setSheet] = useState<null | "search" | "link" | "create">(null);
  const [compact, setCompact] = useCompactOnScroll();
  const keyboard = useKeyboardUp();
  const nav = useRef<HTMLElement>(null);
  const dock = useChatDock(nav, debug);
  const { due, pending, online, seen } = useNavData(signedIn, pathname);
  // /words: its help strip hides under the island; on a first visit (nothing
  // graded yet) its hint shows once above the island, until dismissed.
  useHideWordsStrip(nav);
  const hint = useWordsHint(pathname);
  const tipDismissed = useUi(navTip, (s) => s.dismissed);
  const tip = showFirstTip({ seen, hint, dismissed: tipDismissed });
  useEdgeSwipe(!drawerOpen && !sheet);

  useEffect(() => noteVisit(pathname), [pathname]);
  useEffect(() => setSheet(null), [pathname]);

  // Ctrl/⌘ K: the palette, on any screen.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSheet((s) => (s === "search" ? null : "search"));
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  // What the island covers at rest, for <main>'s bottom padding.
  useEffect(() => {
    const el = nav.current;
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
  }, []);

  const closeSheet = useCallback(() => setSheet(null), []);

  const home = pathname === "/home" || pathname.startsWith("/home/");
  const syncDot = !online ? "offline" : pending > 0 ? "pending" : null;
  const syncLabel = !online ? t.offline : pending > 0 ? fill(t.pending, { n: pending }) : t.synced;
  const dueLabel = due > 0 ? fill(t.due, { n: due }) : "";

  const hidden = keyboard || drawerOpen;
  const bottom = dock ? `${dock}px` : undefined;

  return (
    <>
      <div
        className={`pointer-events-none fixed inset-x-0 z-[35] flex justify-center px-4 md:hidden bottom-[calc(env(safe-area-inset-bottom)+0.625rem)] transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
          hidden ? "translate-y-[150%] opacity-0" : ""
        }`}
        style={bottom ? { bottom } : undefined}
        data-nav-island
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
      >
        {/* First visit to /words: its gestures, once, until dismissed. Later
            they are in the drawer's "?". */}
        {tip && !compact && (
          <div
            role="note"
            data-nav-tip
            className="lk-glass pointer-events-auto absolute bottom-full mb-2 flex w-[min(24rem,calc(100vw-2rem))] items-start gap-2 rounded-2xl border border-[var(--glass-line)] py-2 ps-3 pe-1 text-[13px] leading-snug shadow-[inset_0_1px_0_oklch(1_0_0/0.5),0_10px_28px_-10px_oklch(0.22_0.015_65/0.4)] dark:shadow-[inset_0_1px_0_oklch(1_0_0/0.1),0_10px_28px_-10px_oklch(0_0_0/0.7)]"
          >
            <span className="min-w-0 flex-1 py-1">{hint}</span>
            <button
              type="button"
              onClick={() => navTip.setState({ dismissed: true })}
              aria-label={t.close}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base opacity-70 hover:opacity-100"
            >
              <Icon name="x" />
            </button>
          </div>
        )}
        {/* The capsule while scrolled down: one tap brings the island back. */}
        <button
          type="button"
          aria-label={t.navigation}
          onClick={() => setCompact(false)}
          tabIndex={compact ? 0 : -1}
          className={`lk-glass absolute bottom-1 flex h-11 w-24 items-center justify-center rounded-full border border-[var(--glass-line)] shadow-[inset_0_1px_0_oklch(1_0_0/0.5),0_6px_18px_-6px_oklch(0.22_0.015_65/0.35)] transition-[opacity,transform] duration-300 dark:shadow-[inset_0_1px_0_oklch(1_0_0/0.1),0_6px_18px_-6px_oklch(0_0_0/0.6)] motion-reduce:transition-none ${
            compact
              ? "pointer-events-auto scale-100 opacity-100"
              : "pointer-events-none scale-75 opacity-0"
          }`}
        >
          <span className="h-1.5 w-10 rounded-full bg-[oklch(from_var(--foreground)_l_c_h/0.45)]" />
          {due > 0 && (
            <span className="absolute -top-1 end-1 rounded-full bg-[var(--brand)] px-1.5 text-[10px] font-semibold leading-4 text-[oklch(0.99_0_0)] [text-shadow:none]">
              {badge(due)}
            </span>
          )}
        </button>

        <nav
          ref={nav}
          aria-label={t.navigation}
          data-dock={dock || undefined}
          className={`lk-glass flex items-center gap-1 rounded-full border border-[var(--glass-line)] p-1.5 shadow-[inset_0_1px_0_oklch(1_0_0/0.55),inset_0_-1px_0_oklch(0.22_0.015_65/0.06),0_12px_32px_-10px_oklch(0.22_0.015_65/0.4)] transition-[opacity,transform] duration-300 ease-out dark:shadow-[inset_0_1px_0_oklch(1_0_0/0.12),inset_0_-1px_0_oklch(0_0_0/0.3),0_12px_32px_-10px_oklch(0_0_0/0.7)] motion-reduce:transition-none ${
            compact ? "pointer-events-none translate-y-4 scale-90 opacity-0" : "pointer-events-auto"
          }`}
        >
          <Tab
            as="link"
            href="/home"
            icon="house"
            label={t.home}
            active={home}
            badgeText={badge(due)}
            badgeLabel={dueLabel}
            onClick={() => tick()}
          />
          <Tab
            icon="list"
            label={t.menu}
            onClick={() => {
              tick();
              setDrawerOpen(true);
            }}
            dot={syncDot}
            dotLabel={syncLabel}
            expanded={drawerOpen}
          />
          {/* ＋ Create: third of four, the largest, where the thumb rests. */}
          <button
            type="button"
            aria-label={t.create}
            aria-haspopup="dialog"
            aria-expanded={sheet === "create"}
            onClick={() => {
              tick();
              setSheet((s) => (s === "create" ? null : "create"));
            }}
            className="relative mx-1 flex h-[3.75rem] w-[3.75rem] shrink-0 touch-manipulation select-none items-center justify-center rounded-full bg-[oklch(from_var(--brand)_l_c_h/0.88)] text-[1.75rem] text-[oklch(0.985_0.01_82)] shadow-[inset_0_1px_0_oklch(1_0_0/0.45),0_6px_16px_-4px_oklch(from_var(--brand)_l_c_h/0.6)] [text-shadow:none] active:scale-95 motion-reduce:active:scale-100"
          >
            <Icon name="plus" />
          </button>
          <Tab
            icon="magnifyingGlass"
            label={t.search}
            onClick={() => {
              tick();
              setSheet("search");
            }}
            expanded={sheet === "search" || sheet === "link"}
          />
        </nav>
      </div>

      <SearchPalette
        open={sheet === "search" || sheet === "link"}
        mode={sheet === "link" ? "link" : "search"}
        onClose={closeSheet}
        onCreateLink={() => setSheet("link")}
        t={t}
        signedIn={signedIn}
        debug={debug}
      />
      <CreateSheet
        open={sheet === "create"}
        onClose={closeSheet}
        onPick={(href) => {
          if (href === "#link") setSheet("link");
          else {
            setSheet(null);
            router.push(href);
          }
        }}
        t={t}
        bottom={bottom}
      />
    </>
  );
}

function Tab({
  as,
  href,
  icon,
  label,
  active,
  onClick,
  badgeText,
  badgeLabel,
  dot,
  dotLabel,
  expanded,
}: {
  as?: "link";
  href?: string;
  icon: IconName;
  label: string;
  active?: boolean;
  onClick?: () => void;
  badgeText?: string;
  badgeLabel?: string;
  dot?: "offline" | "pending" | null;
  dotLabel?: string;
  expanded?: boolean;
}) {
  const body = (
    <>
      <span className="relative text-[1.45rem] leading-none">
        <Icon name={icon} weight={active ? "fill" : "regular"} />
        {badgeText && (
          <span className="absolute -end-3 -top-1.5 min-w-4 rounded-full bg-[var(--brand)] px-1 text-center text-[10px] font-semibold leading-4 text-[oklch(0.99_0_0)] [text-shadow:none]">
            {badgeText}
          </span>
        )}
        {dot && (
          <span
            className={`absolute -end-1 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--background)] ${
              dot === "offline" ? "bg-[oklch(0.62_0.01_65)]" : "bg-[oklch(0.76_0.15_75)]"
            }`}
          />
        )}
      </span>
      <span className="mt-0.5 max-w-full truncate text-[10.5px] font-medium leading-3">
        {label}
      </span>
    </>
  );
  const cls = `flex h-14 w-16 flex-col items-center justify-center rounded-full px-1 touch-manipulation transition-colors ${
    active
      ? "bg-[oklch(from_var(--foreground)_l_c_h/0.08)] text-[var(--brand)]"
      : "hover:bg-[oklch(from_var(--foreground)_l_c_h/0.06)]"
  }`;
  const aria = [label, badgeLabel, dot ? dotLabel : ""].filter(Boolean).join(". ");
  if (as === "link" && href)
    return (
      <Link
        href={href}
        aria-label={aria}
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        className={cls}
      >
        {body}
      </Link>
    );
  return (
    <button
      type="button"
      aria-label={aria}
      aria-expanded={expanded}
      onClick={onClick}
      className={cls}
    >
      {body}
    </button>
  );
}
