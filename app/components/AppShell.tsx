"use client";

import Image from "next/image";
import { BrandName } from "./BrandName";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { APP_NAV, NAV_GROUPS, activeNavKey, type NavGroup } from "@/lib/app-nav";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { FirstRunChoice, type FirstRunLabels } from "./FirstRunChoice";
import { Icon, SealIcon } from "./icons";
import { useDebugToggle } from "./useDebugToggle";
import { useIntlayer } from "next-intlayer";
import { useUi } from "@lianki/ui-state";
import { island } from "@/lib/islands/Island";
import { navUi, setDrawerOpen } from "@/lib/nav/ui-store";
import { BottomIsland } from "@/lib/nav/islands/BottomIsland";
import { NavRows } from "@/lib/nav/islands/NavRows";

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
  ui: { menu: string; collapse: string; expand: string; closeMenu: string };
};

interface AppShellProps {
  locale: string;
  appName: string;
  labels: ShellLabels;
  user: ShellUser;
  /** Absent only if a caller has no content for it; the prompt then stays off. */
  firstRun?: FirstRunLabels;
  children: React.ReactNode;
}

export function AppShell({ locale, appName, labels, user, firstRun, children }: AppShellProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  // The nav store (lib/nav/ui-store.ts): the bottom island opens the drawer too.
  const drawerOpen = useUi(navUi, (s) => s.drawerOpen);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [debug, debugTap] = useDebugToggle(undefined, 10);
  /** The debug chat's user-facing name ("Learning Partner"), shown while it is on. */
  const partner = useIntlayer("learning-partner");

  // Read the persisted collapse state after mount — reading localStorage during
  // render would desync SSR and hydration.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
    } catch {
      // private mode / blocked storage — keep the expanded default
    }
  }, []);

  const profileRef = useRef<HTMLDivElement>(null);

  // Route change closes the mobile drawer and the profile menu; they are
  // overlays, not destinations.
  useEffect(() => {
    setDrawerOpen(false);
    setIsProfileOpen(false);
  }, [pathname]);

  // The profile menu closes on a press outside it and on Escape. Blur alone is
  // not enough: iOS Safari does not focus a button on tap, so the trigger never
  // blurs there. Presses inside (the trigger, the 10-tap name row) are ignored.
  useEffect(() => {
    if (!isProfileOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!profileRef.current?.contains(e.target as Node)) setIsProfileOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsProfileOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isProfileOpen]);

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

  const sidebar = (place: "drawer" | "sidebar") => (
    <nav
      aria-label={labels.ui.menu}
      className={`flex flex-col gap-6 py-4 ${collapsed ? "px-2" : "px-3"}`}
    >
      <NavDrawerIsland place={place} collapsed={place === "sidebar" && collapsed} />
      {NAV_GROUPS.map((group) => {
        const items = APP_NAV.filter((item) => item.group === group);
        if (!items.length) return null;
        return (
          <div key={group}>
            {!collapsed && (
              <h2 className="px-3 mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                {labels.groups[group]}
              </h2>
            )}
            <ul className="space-y-0.5">
              {items.map((item) => {
                const label = labels[item.key] ?? item.key;
                const isActive = active === item.key;
                return (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      title={label}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        isActive
                          ? "font-semibold text-gray-900 dark:text-gray-100"
                          : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                      } ${collapsed ? "justify-center" : ""}`}
                    >
                      {/* Style C: an ink line icon; the current page's is stamped in seal red. */}
                      <span className="flex w-5 shrink-0 justify-center text-lg leading-none">
                        {isActive ? <SealIcon name={item.icon} /> : <Icon name={item.icon} />}
                      </span>
                      {collapsed ? (
                        <span className="sr-only">{label}</span>
                      ) : (
                        // One line, always: a long label (fr "Listes de mots")
                        // wrapped and ran into the next row on iOS.
                        <span className="min-w-0 truncate">{label}</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
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
      {/* Slim topbar: glass, above full-screen content such as the /words list. */}
      <header className="lk-glass lk-glass-bleed-top lk-header-bleed relative z-30 flex items-center gap-3 h-14 border-b border-[var(--glass-line)] shrink-0">
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
          <img src="/icon.svg" alt="" width={28} height={28} className="rounded-md" />
          <BrandIsland appName={appName} locale={locale} />
        </Link>

        <div className="ms-auto flex items-center gap-3">
          <LanguageSwitcher />
          {user ? (
            <div className="relative" ref={profileRef}>
              <button
                data-profile-menu
                onClick={() => setIsProfileOpen(!isProfileOpen)}
                // Keyboard: tabbing out of the menu closes it. A press on
                // something unfocusable gives no relatedTarget; the pointerdown
                // listener above decides those.
                onBlur={(e) => {
                  const to = e.relatedTarget as Node | null;
                  if (to && !profileRef.current?.contains(to)) setIsProfileOpen(false);
                }}
                aria-expanded={isProfileOpen}
                className="flex items-center gap-2 text-sm font-medium hover:opacity-80 transition-opacity"
              >
                {user.image && (
                  <Image
                    className="w-8 h-8 rounded-full ring-2 ring-gray-200 dark:ring-gray-700"
                    alt={user.name}
                    src={user.image}
                    width={32}
                    height={32}
                  />
                )}
                <span className="hidden md:inline max-w-[120px] truncate">{user.name}</span>
                <ChevronIcon open={isProfileOpen} />
              </button>

              {isProfileOpen && (
                <div
                  // A link chosen in the menu closes it, even when it points at
                  // the page already open (no route change to do it).
                  onClick={(e) => {
                    if ((e.target as Element).closest("a")) setIsProfileOpen(false);
                  }}
                  className="absolute end-0 mt-2 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-50"
                >
                  {/* Hidden: ten quick taps on your own name toggle debug mode.
                      The taps land inside the menu, so it stays open; mousedown
                      is cancelled so a desktop click doesn't move focus. */}
                  <div
                    data-debug-name
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={debugTap}
                    className="select-none touch-manipulation px-4 py-2 text-sm text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 truncate"
                  >
                    {user.email}
                    {debug && ` · ${partner.name.value}`}
                  </div>
                  <MenuLink href="/list">{labels.dashboard}</MenuLink>
                  <MenuLink href="/profile">{labels.profile}</MenuLink>
                  <MenuLink href="/preferences">{labels.preferences}</MenuLink>
                  <MenuLink href="/membership">{labels.membership}</MenuLink>
                  <div className="border-t border-gray-200 dark:border-gray-700 mt-2 pt-2">
                    <Link
                      href="/auth/logout"
                      className="flex items-center gap-2 px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <Icon name="signOut" />
                      {labels.signOut}
                    </Link>
                  </div>
                </div>
              )}
            </div>
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
          <div className="sticky top-0">{sidebar("sidebar")}</div>
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
            <div className="relative w-64 max-w-[80%] h-full overflow-y-auto pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] bg-white dark:bg-gray-900 border-e border-gray-200 dark:border-gray-800">
              {sidebar("drawer")}
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

function MenuLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700">
      {children}
    </Link>
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

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}
