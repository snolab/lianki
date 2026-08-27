"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { APP_NAV, NAV_GROUPS, activeNavKey, type NavGroup } from "@/lib/app-nav";
import { appHref } from "@/lib/app-locale";
import { LanguageSwitcher } from "./LanguageSwitcher";

const SIDEBAR_KEY = "lk:sidebar";

export type ShellUser = {
  name: string;
  email: string;
  image?: string | null;
} | null;

export type ShellLabels = Record<string, string> & {
  groups: Record<NavGroup, string>;
  ui: { menu: string; collapse: string; expand: string };
};

interface AppShellProps {
  locale: string;
  appName: string;
  labels: ShellLabels;
  user: ShellUser;
  children: React.ReactNode;
}

export function AppShell({ locale, appName, labels, user, children }: AppShellProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  // Read the persisted collapse state after mount — reading localStorage during
  // render would desync SSR and hydration.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
    } catch {
      // private mode / blocked storage — keep the expanded default
    }
  }, []);

  // Route change closes the mobile drawer; it is an overlay, not a destination.
  useEffect(() => setDrawerOpen(false), [pathname]);

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

  const sidebar = (
    <nav
      aria-label={labels.ui.menu}
      className={`flex flex-col gap-6 py-4 ${collapsed ? "px-2" : "px-3"}`}
    >
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
                      href={appHref(item.href, locale)}
                      aria-current={isActive ? "page" : undefined}
                      title={collapsed ? label : undefined}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        isActive
                          ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                          : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                      } ${collapsed ? "justify-center" : ""}`}
                    >
                      <span aria-hidden className="text-base leading-none w-5 text-center">
                        {item.icon}
                      </span>
                      {collapsed ? <span className="sr-only">{label}</span> : <span>{label}</span>}
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
    <div className="min-h-screen flex flex-col">
      {/* Slim topbar */}
      <header className="flex items-center gap-3 px-4 h-14 border-b border-gray-200 dark:border-gray-800 shrink-0">
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

        <Link href={`/${locale}`} className="text-xl font-bold hover:opacity-80 transition-opacity">
          {appName}
        </Link>

        <div className="ms-auto flex items-center gap-3">
          <LanguageSwitcher />
          {user ? (
            <div className="relative">
              <button
                onClick={() => setIsProfileOpen(!isProfileOpen)}
                onBlur={() => setTimeout(() => setIsProfileOpen(false), 150)}
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
                <div className="absolute end-0 mt-2 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-50">
                  <div className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 truncate">
                    {user.email}
                  </div>
                  <MenuLink href={appHref("/list", locale)}>{labels.dashboard}</MenuLink>
                  <MenuLink href={appHref("/profile", locale)}>{labels.profile}</MenuLink>
                  <MenuLink href={appHref("/preferences", locale)}>{labels.preferences}</MenuLink>
                  <MenuLink href={appHref("/membership", locale)}>{labels.membership}</MenuLink>
                  <div className="border-t border-gray-200 dark:border-gray-700 mt-2 pt-2">
                    <Link
                      href="/auth/logout"
                      className="block px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      {labels.signOut}
                    </Link>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Link
              href={appHref("/sign-in", locale)}
              className="text-sm font-medium hover:underline"
            >
              {labels.signIn}
            </Link>
          )}
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Desktop sidebar */}
        <aside
          className={`hidden md:block shrink-0 border-e border-gray-200 dark:border-gray-800 ${
            collapsed ? "w-16" : "w-56"
          }`}
        >
          <div className="sticky top-0">{sidebar}</div>
        </aside>

        {/* Mobile drawer */}
        {drawerOpen && (
          <div className="md:hidden fixed inset-0 z-40 flex">
            <button
              type="button"
              aria-label={labels.ui.collapse}
              className="absolute inset-0 bg-black/40"
              onClick={() => setDrawerOpen(false)}
            />
            <div className="relative w-64 max-w-[80%] h-full overflow-y-auto bg-white dark:bg-gray-900 border-e border-gray-200 dark:border-gray-800">
              {sidebar}
            </div>
          </div>
        )}

        <main className="flex-1 min-w-0">{children}</main>
      </div>
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
