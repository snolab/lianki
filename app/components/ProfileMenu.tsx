"use client";

/**
 * The account menu: the avatar button and what it opens (profile, import,
 * data, settings, membership, language, sign out). One component, three
 * places: the top bar, the foot of the desktop rail while the top bar is
 * scrolled away, and the foot of the phone drawer. The account menu is never
 * out of reach (owner, 2026-11-09).
 */
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { isOwnAvatar } from "@/lib/profile/avatar";
import { MENU_NAV } from "@/lib/app-nav";
import { signOut } from "@/lib/sign-out";
import { Icon } from "./icons";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useDebugToggle } from "./useDebugToggle";
import { DevServerDot, DevSwitchItem, type DevSwitch } from "./DevSwitchItem";
import { LiveViewChip, type LiveViewShell } from "./LiveView";
import type { ShellLabels } from "./AppShell";

export type ProfileUser = { name: string; email: string; image?: string | null };

interface ProfileMenuProps {
  user: ProfileUser;
  labels: ShellLabels;
  devSwitch?: DevSwitch;
  liveView?: LiveViewShell;
  /** header: top bar, menu drops down. rail/drawer: pinned at the foot, menu opens upward. */
  place: "header" | "rail" | "drawer";
  /** The icon-only rail: the avatar alone. */
  compact?: boolean;
}

export function ProfileMenu({
  user,
  labels,
  devSwitch,
  liveView,
  place,
  compact,
}: ProfileMenuProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [debug, debugTap] = useDebugToggle(undefined, 10);
  /** The debug chat's user-facing name ("Learning Partner"), shown while it is on. */
  const partner = useIntlayer("learning-partner");
  const ref = useRef<HTMLDivElement>(null);
  const foot = place !== "header";

  // A route change closes it: it is an overlay, not a destination.
  useEffect(() => setOpen(false), [pathname]);

  // Closes on a press outside it and on Escape. Blur alone is not enough: iOS
  // Safari does not focus a button on tap, so the trigger never blurs there.
  // Presses inside (the trigger, the 10-tap name row) and in the language
  // sheet it opened (portalled to <body>) are ignored.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest?.(".lk-lang-backdrop")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // The language sheet closes first; its own Escape handler does that.
      if (e.key === "Escape" && !document.querySelector(".lk-lang-backdrop")) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const showName = place === "header" ? "hidden md:inline" : compact ? "sr-only" : "";

  return (
    <div className={`relative ${foot ? "w-full" : ""}`} ref={ref}>
      <button
        type="button"
        {...(foot ? { "data-rail-profile": place } : { "data-profile-menu": "" })}
        onClick={() => setOpen(!open)}
        // Keyboard: tabbing out of the menu closes it. A press on something
        // unfocusable gives no relatedTarget; the pointerdown listener decides those.
        onBlur={(e) => {
          const to = e.relatedTarget as Node | null;
          if (to && !ref.current?.contains(to)) setOpen(false);
        }}
        aria-expanded={open}
        title={compact ? user.name : undefined}
        className={
          foot
            ? `flex w-full min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800 ${compact ? "justify-center px-0" : ""}`
            : "relative flex items-center gap-2 text-sm font-medium hover:opacity-80 transition-opacity"
        }
      >
        {devSwitch?.mode === "back" && <DevServerDot label={devSwitch.labels.name} />}
        {user.image ? (
          <Image
            className="w-8 h-8 shrink-0 rounded-full ring-2 ring-gray-200 dark:ring-gray-700"
            alt={user.name}
            src={user.image}
            // An upload of ours is already small, and next/image's loader can't fetch /api/*.
            unoptimized={isOwnAvatar(user.image) || user.image.startsWith("blob:")}
            width={32}
            height={32}
          />
        ) : (
          foot && (
            <span className="flex w-5 shrink-0 justify-center text-lg leading-none">
              <Icon name="user" />
            </span>
          )
        )}
        <span className={`${showName} min-w-0 max-w-[120px] truncate`}>{user.name}</span>
        {!compact && <ChevronIcon open={open} up={foot} />}
      </button>

      {open && (
        <div
          // A link chosen in the menu closes it, even when it points at the
          // page already open (no route change to do it).
          onClick={(e) => {
            if ((e.target as Element).closest("a")) setOpen(false);
          }}
          className={`absolute w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-50 ${
            foot ? "bottom-full start-0 mb-2" : "end-0 mt-2"
          }`}
        >
          {/* Hidden: ten quick taps on your own name toggle debug mode. The
              taps land inside the menu, so it stays open; mousedown is
              cancelled so a desktop click doesn't move focus. */}
          <div
            data-debug-name
            onMouseDown={(e) => e.preventDefault()}
            onClick={debugTap}
            className="select-none touch-manipulation px-4 py-2 text-sm text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 truncate"
          >
            {user.email}
            {debug && ` · ${partner.name.value}`}
          </div>
          {/* Owner's order, 2026-11-09: profile, import, data, settings, language, sign out. */}
          <MenuLink href="/profile" icon="user">
            {labels.profile}
          </MenuLink>
          {MENU_NAV.map((item) => (
            <MenuLink key={item.key} href={item.href} icon={item.icon}>
              {labels[item.key] ?? item.key}
            </MenuLink>
          ))}
          <MenuLink href="/membership" icon="star">
            {labels.membership}
          </MenuLink>
          <LanguageSwitcher variant="menu" />
          {/* One preview control: the whole-page switch, with Live view (dev
              parts on lianki.com) as a chip in the same row, only on
              lianki.com: the preview build is all dev code already. */}
          {devSwitch && (
            <DevSwitchItem sw={devSwitch}>
              {liveView && devSwitch.mode === "go" && (liveView.wanted || liveView.ready) && (
                <LiveViewChip lv={liveView} />
              )}
            </DevSwitchItem>
          )}
          <div className="border-t border-gray-200 dark:border-gray-700 mt-2 pt-2">
            <button
              type="button"
              data-sign-out
              onClick={(e) => {
                e.currentTarget.disabled = true;
                void signOut();
              }}
              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-left text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-60"
            >
              <Icon name="signOut" />
              {labels.signOut}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ComponentProps<typeof Icon>["name"];
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
    >
      <Icon name={icon} className="opacity-70" />
      {children}
    </Link>
  );
}

function ChevronIcon({ open, up }: { open: boolean; up?: boolean }) {
  // Points the way the menu opens: down from the top bar, up from the foot.
  const flip = up ? !open : open;
  return (
    <svg
      className={`w-4 h-4 shrink-0 ms-auto transition-transform ${flip ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}
