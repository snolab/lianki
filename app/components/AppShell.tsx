"use client";

import { BrandName } from "./BrandName";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { NAV_GROUPS, activeNavKey, railNav, type NavGroup, type NavItem } from "@/lib/app-nav";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { FirstRunChoice, type FirstRunLabels } from "./FirstRunChoice";
import { Icon, SealIcon } from "./icons";
import { useUi } from "@lianki/ui-state";
import { island } from "@/lib/islands/Island";
import { navUi, setDrawerOpen } from "@/lib/nav/ui-store";
import { BottomIsland } from "@/lib/nav/islands/BottomIsland";
import { NavRows } from "@/lib/nav/islands/NavRows";
import type { DevSwitch } from "./DevSwitchItem";
import { LiveViewBoot, type LiveViewShell } from "./LiveView";
import { LevelChip } from "./LevelChip";
import { useShellUser } from "./BoxApiBridge";
import { ProfileMenu } from "./ProfileMenu";
import { edgeFade, useRailFit } from "./useRailFit";

const SIDEBAR_KEY = "lk:sidebar";

/** The bottom island and the nav's extra rows (docs/bottom-nav.md): hot-swappable slots. */
const BottomNavIsland = island("nav.bottom", BottomIsland);
const NavDrawerIsland = island("nav.drawer", NavRows);
/** The wordmark, the same island as the Header's (lib/brand.ts). */
const BrandIsland = island("header.brand", BrandName);

export type ShellUser = {
  name: string;
  email: string;
  image?: string | null;
} | null;

export type ShellLabels = Record<string, string> & {
  groups: Record<NavGroup, string>;
  ui: { menu: string; collapse: string; expand: string; closeMenu: string; more: string };
};

interface AppShellProps {
  locale: string;
  appName: string;
  labels: ShellLabels;
  user: ShellUser;
  /** Absent only if a caller has no content for it; the prompt then stays off. */
  firstRun?: FirstRunLabels;
  /** The owner's dev-server switch: set by the server for the owner only (lib/dev-server-switch.ts). */
  devSwitch?: DevSwitch;
  /** Live view (docs/live-view.md): set by the server for the owner only. */
  liveView?: LiveViewShell;
  /** Flag-gated nav items this viewer gets (lib/app-nav.ts `flag`), decided by the server. */
  navShown?: string[];
  /** Learner levels shown to this viewer (lib/level-progress.ts `levelsOn`), decided by the server. */
  levels?: boolean;
  children: React.ReactNode;
}

export function AppShell({
  locale,
  appName,
  labels,
  user: serverUser,
  firstRun,
  devSwitch,
  liveView,
  navShown,
  levels,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  // On a box, the account lianki.com named for its token (BoxApiBridge).
  const user = useShellUser(serverUser);
  const [collapsed, setCollapsed] = useState(false);
  // The nav store (lib/nav/ui-store.ts): the bottom island opens the drawer too.
  const drawerOpen = useUi(navUi, (s) => s.drawerOpen);
  /** The top bar is in view; while it is scrolled away the rail's foot carries the account menu. */
  const [headerShown, setHeaderShown] = useState(true);

  // Read the persisted collapse state after mount — reading localStorage during
  // render would desync SSR and hydration.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
    } catch {
      // private mode / blocked storage — keep the expanded default
    }
  }, []);

  const headerRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const listFade = useCallback((el: HTMLElement | null) => {
    listRef.current = el;
    return edgeFade(el);
  }, []);

  // Route change closes the mobile drawer; it is an overlay, not a destination.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // The top bar scrolls away with the page. Its visible height drives the
  // sticky rail's (--lk-head-vis, .lk-rail), and once it is gone the rail's
  // foot shows the account menu, so that is never out of reach.
  useEffect(() => {
    const header = headerRef.current;
    const rail = railRef.current;
    if (!header || !rail) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const shown = Math.max(0, header.getBoundingClientRect().bottom);
      rail.style.setProperty("--lk-head-vis", `${shown}px`);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const io = new IntersectionObserver(([e]) => setHeaderShown(e.isIntersecting));
    io.observe(header);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      io.disconnect();
    };
  }, []);

  // Escape closes the mobile drawer, as it would any modal dialog.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }

  const active = activeNavKey(pathname);

  // The rail's links: the first group always stays; when the window is too
  // short, links from the end move into "⋯" (useRailFit).
  const items = railNav(navShown);
  const movable = items.filter((i) => i.group !== NAV_GROUPS[0]);
  const hidden = useRailFit({
    rail: railRef,
    list: listRef,
    rows: rowsRef,
    header: headerRef,
    movable: movable.length,
    enabled: true,
    resetKey: `${collapsed}|${items.map((i) => i.key).join()}`,
  });
  const overflow = hidden ? movable.slice(-hidden) : [];

  const links = (place: "drawer" | "sidebar") => {
    const narrow = place === "sidebar" && collapsed;
    const out = place === "sidebar" ? new Set(overflow.map((i) => i.key)) : new Set<string>();
    return (
      <>
        <div ref={place === "sidebar" ? rowsRef : undefined} className="empty:hidden">
          <NavDrawerIsland place={place} collapsed={narrow} />
        </div>
        {NAV_GROUPS.map((group) => {
          const shown = items.filter((item) => item.group === group && !out.has(item.key));
          if (!shown.length) return null;
          return (
            <div key={group}>
              {!narrow && (
                // The page-card group is headed by the brand LiCards, which an
                // uppercase transform would turn into LICARDS.
                <h2
                  className={`px-3 mb-1 text-xs font-semibold tracking-wide text-gray-400 dark:text-gray-500 ${group === "advanced" ? "" : "uppercase"}`}
                >
                  {labels.groups[group]}
                </h2>
              )}
              <ul className="space-y-0.5">
                {shown.map((item) => (
                  <li key={item.key}>
                    <NavLink
                      item={item}
                      label={labels[item.key] ?? item.key}
                      active={active === item.key}
                      narrow={narrow}
                    />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </>
    );
  };

  /** The account menu, or Sign in, pinned at the foot of the rail and the drawer. */
  const foot = (place: "rail" | "drawer") =>
    user ? (
      <ProfileMenu
        user={user}
        labels={labels}
        devSwitch={devSwitch}
        liveView={liveView}
        place={place}
        compact={place === "rail" && collapsed}
      />
    ) : (
      <Link
        href="/sign-in"
        title={labels.signIn}
        className={`flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800 ${place === "rail" && collapsed ? "justify-center" : ""}`}
      >
        <span className="flex w-5 shrink-0 justify-center text-lg leading-none">
          <Icon name="signIn" />
        </span>
        <span className={place === "rail" && collapsed ? "sr-only" : ""}>{labels.signIn}</span>
      </Link>
    );

  return (
    // --nav-w: the nav's width from the tablet up (0 on a phone, where it is a
    // drawer). Overlays and content that run under the tablet's glass nav pad
    // or offset themselves by it.
    <div
      className={`min-h-screen flex flex-col [--nav-w:0px] ${
        collapsed ? "md:[--nav-w:4rem]" : "md:[--nav-w:14rem]"
      }`}
    >
      {liveView && <LiveViewBoot lv={liveView} />}
      {/* Slim topbar: glass, above full-screen content such as the /words list. */}
      <header
        ref={headerRef}
        className="lk-glass lk-glass-bleed-top lk-header-bleed relative z-30 flex items-center gap-3 h-14 border-b border-[var(--glass-line)] shrink-0"
      >
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label={labels.ui.menu}
          className="md:hidden p-2 -ms-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <MenuIcon />
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? labels.ui.expand : labels.ui.collapse}
          aria-expanded={!collapsed}
          className="hidden md:inline-flex p-2 -ms-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <MenuIcon />
        </button>

        <Link
          href={`/${locale}`}
          className="flex items-center gap-2 text-xl font-bold hover:opacity-80 transition-opacity"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a tiny static SVG */}
          <img src="/icon.svg?v=5" alt="" width={28} height={28} />
          <BrandIsland appName={appName} locale={locale} />
        </Link>

        <div className="ms-auto flex items-center gap-3">
          <LanguageSwitcher />
          {user && levels && <LevelChip />}
          {user ? (
            <ProfileMenu
              user={user}
              labels={labels}
              devSwitch={devSwitch}
              liveView={liveView}
              place="header"
            />
          ) : (
            <Link
              href="/sign-in"
              className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
            >
              <Icon name="signIn" className="text-lg" />
              {labels.signIn}
            </Link>
          )}
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar: in flow on a desktop; on a tablet a glass overlay (.lk-nav-overlay)
            that takes no width — <main> is padded by --nav-w instead. */}
        <aside
          data-app-nav
          className={`lk-nav-overlay hidden md:block shrink-0 border-e border-gray-200 dark:border-gray-800 ${
            collapsed ? "w-16" : "w-56"
          }`}
        >
          <div ref={railRef} data-rail className="lk-rail flex flex-col">
            <nav
              ref={listFade}
              aria-label={labels.ui.menu}
              className={`lk-rail-scroll flex min-h-0 flex-1 flex-col gap-6 py-4 ${collapsed ? "px-2" : "px-3"}`}
            >
              {links("sidebar")}
            </nav>
            <div className={`flex shrink-0 flex-col gap-1 pb-3 ${collapsed ? "px-2" : "px-3"}`}>
              {overflow.length > 0 && (
                <MoreMenu items={overflow} labels={labels} active={active} narrow={collapsed} />
              )}
              {/* Space kept while the top bar (which has the avatar) is in
                  view, so the links do not move in and out of "⋯" as it
                  scrolls away. */}
              <div data-rail-foot inert={headerShown} className={headerShown ? "invisible" : ""}>
                {foot("rail")}
              </div>
            </div>
          </div>
        </aside>

        {/* Mobile drawer */}
        {drawerOpen && (
          <div
            className="md:hidden fixed inset-0 z-40 flex"
            role="dialog"
            aria-modal="true"
            aria-label={labels.ui.menu}
            data-drawer
          >
            <button
              type="button"
              aria-label={labels.ui.closeMenu}
              className="absolute inset-0 bg-black/40"
              onClick={() => setDrawerOpen(false)}
            />
            <div className="relative flex w-64 max-w-[80%] h-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] bg-white dark:bg-gray-900 border-e border-gray-200 dark:border-gray-800">
              <nav
                aria-label={labels.ui.menu}
                ref={edgeFade}
                className="lk-rail-scroll flex min-h-0 flex-1 flex-col gap-6 px-3 py-4"
              >
                {links("drawer")}
              </nav>
              <div className="shrink-0 px-3 pb-3">{foot("drawer")}</div>
            </div>
          </div>
        )}

        {/* --lk-bottom-reserve: what the bottom island covers at rest (it
            sets the variable), so the last of the content can scroll clear of it. */}
        <main className="lk-nav-pad flex-1 min-w-0 pb-[var(--lk-bottom-reserve,0px)]">
          {children}
        </main>
      </div>

      <BottomNavIsland signedIn={user !== null} />

      {/* Signed-out only: a signed-in visitor answered this by signing in. */}
      {user === null && firstRun && <FirstRunChoice labels={firstRun} />}
    </div>
  );
}

function NavLink({
  item,
  label,
  active,
  narrow,
}: {
  item: NavItem;
  label: string;
  active: boolean;
  narrow: boolean;
}) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={label}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "font-semibold text-gray-900 dark:text-gray-100"
          : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
      } ${narrow ? "justify-center" : ""}`}
    >
      {/* Style C: an ink line icon; the current page's is stamped in seal red. */}
      <span className="flex w-5 shrink-0 justify-center text-lg leading-none">
        {active ? <SealIcon name={item.icon} /> : <Icon name={item.icon} />}
      </span>
      {narrow ? (
        <span className="sr-only">{label}</span>
      ) : (
        // One line, always: a long label (fr "Listes de mots") wrapped and
        // ran into the next row on iOS.
        <span className="min-w-0 truncate">{label}</span>
      )}
    </Link>
  );
}

/**
 * "⋯": the rail's links that did not fit (useRailFit), in a popover beside it.
 * Escape and a press outside close it; Escape gives focus back to "⋯".
 */
function MoreMenu({
  items,
  labels,
  active,
  narrow,
}: {
  items: NavItem[];
  labels: ShellLabels;
  active: string | null;
  narrow: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // The current page is in here: "⋯" says so with its own weight.
  const holdsActive = items.some((i) => i.key === active);
  return (
    <div ref={ref} className="relative" data-rail-more>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls="lk-rail-more"
        title={labels.ui.more}
        onClick={() => setOpen(!open)}
        className={`flex w-full min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 ${
          holdsActive
            ? "font-semibold text-gray-900 dark:text-gray-100"
            : "font-medium text-gray-700 dark:text-gray-300"
        } ${narrow ? "justify-center" : ""}`}
      >
        <span className="flex w-5 shrink-0 justify-center text-lg leading-none">
          <Icon name="dotsThree" />
        </span>
        <span className={narrow ? "sr-only" : "min-w-0 truncate"}>{labels.ui.more}</span>
      </button>
      {open && (
        <ul
          id="lk-rail-more"
          className="lk-rail-more absolute bottom-0 start-full z-50 ms-2 w-56 space-y-0.5 rounded-lg border border-[var(--glass-line)] p-1 shadow-lg"
        >
          {items.map((item) => (
            <li key={item.key}>
              <NavLink
                item={item}
                label={labels[item.key] ?? item.key}
                active={active === item.key}
                narrow={false}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MenuIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6h16M4 12h16M4 18h16"
      />
    </svg>
  );
}
