"use client";

/**
 * The rows above the nav list (`nav.drawer`, docs/bottom-nav.md): where you
 * are (breadcrumbs, with a pin toggle for this page), pinned pages and the
 * pages visited recently in this tab. In the phone drawer and the expanded
 * desktop sidebar; nothing when the sidebar is collapsed.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/app/components/icons";
import { APP_NAV, activeNavKey } from "@/lib/app-nav";
import type { IslandProps } from "@/lib/islands/contract";
import { useUi } from "@lianki/ui-state";
import { navPins, navUi, setDrawerOpen, togglePin } from "../ui-store";
import { openChat } from "./chat";
import { useDebugMode, useWordsHint } from "./signals";
import { useNavText } from "./text";

export function NavRows({ place, collapsed }: IslandProps["nav.drawer"]) {
  const t = useNavText();
  const pathname = usePathname() ?? "/";
  const pinned = useUi(navPins, (s) => s.pinned);
  const recent = useUi(navUi, (s) => s.recent);
  const hint = useWordsHint(pathname);
  const [help, setHelp] = useState(false);
  const debug = useDebugMode();
  if (collapsed) return null;

  const key = activeNavKey(pathname);
  const item = APP_NAV.find((i) => i.key === key);
  const title = (p: string) => {
    const k = activeNavKey(p.split("?")[0]);
    return (k && t.pages[k]) || p;
  };
  const isPinned = pinned.includes(pathname);
  const others = recent.filter((p) => p !== pathname && !pinned.includes(p)).slice(0, 4);

  const row = (p: string, icon: "pushPin" | "clock") => {
    const k = activeNavKey(p.split("?")[0]);
    const navIcon = APP_NAV.find((i) => i.key === k)?.icon;
    return (
      <li key={`${icon}:${p}`}>
        <Link
          href={p}
          aria-current={p === pathname ? "page" : undefined}
          className="flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-[oklch(from_var(--foreground)_l_c_h/0.06)]"
        >
          <span className="flex w-5 shrink-0 justify-center text-lg leading-none opacity-80">
            <Icon name={navIcon ?? icon} />
          </span>
          <span className="min-w-0 truncate">{title(p)}</span>
        </Link>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4" data-nav-rows={place}>
      {place === "drawer" && (
        <div className="flex items-center gap-1 px-3">
          <nav aria-label={t.breadcrumb} className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-1 text-xs opacity-70">
              <li>
                <Link href="/home" className="hover:underline">
                  {t.home}
                </Link>
              </li>
              {item && item.key !== "home" && (
                <>
                  <li aria-hidden>
                    <Icon name="caretRight" className="text-[0.65rem]" />
                  </li>
                  <li className="truncate">{t.groups[item.group]}</li>
                  <li aria-hidden>
                    <Icon name="caretRight" className="text-[0.65rem]" />
                  </li>
                  <li aria-current="page" className="truncate font-semibold">
                    {t.pages[item.key]}
                  </li>
                </>
              )}
            </ol>
          </nav>
          <button
            type="button"
            onClick={() => togglePin(pathname)}
            aria-pressed={isPinned}
            aria-label={isPinned ? t.unpin : t.pin}
            title={isPinned ? t.unpin : t.pin}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg ${isPinned ? "text-[var(--brand)]" : "opacity-60 hover:opacity-100"}`}
          >
            <Icon name="pushPin" weight={isPinned ? "fill" : "regular"} />
          </button>
          {/* /words: its gestures and shortcuts, hidden under the island on a phone. */}
          {hint && (
            <button
              type="button"
              onClick={() => setHelp((v) => !v)}
              aria-expanded={help}
              aria-controls="lk-nav-help"
              aria-label={t.gestures}
              title={t.gestures}
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-semibold ${help ? "text-[var(--brand)]" : "opacity-60 hover:opacity-100"}`}
            >
              ?
            </button>
          )}
        </div>
      )}
      {place === "drawer" && hint && help && (
        <div
          id="lk-nav-help"
          role="note"
          className="mx-3 rounded-xl border border-[var(--glass-line)] px-3 py-2 text-[13px] leading-snug"
        >
          {t.gestures && (
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-60">
              {t.gestures}
            </div>
          )}
          {hint}
        </div>
      )}
      {/* The Learning Partner (debug mode, where the chat is on): it is no longer on the island. */}
      {debug && (
        <ul>
          <li>
            <button
              type="button"
              onClick={() => {
                setDrawerOpen(false);
                openChat();
              }}
              className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm hover:bg-[oklch(from_var(--foreground)_l_c_h/0.06)]"
            >
              <span className="flex w-5 shrink-0 justify-center text-lg leading-none text-[var(--brand)]">
                <Icon name="chatCircleDots" />
              </span>
              <span className="min-w-0 truncate">{t.partner}</span>
            </button>
          </li>
        </ul>
      )}
      {pinned.length > 0 && (
        <div>
          <h2 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide opacity-60">
            {t.pinned}
          </h2>
          <ul className="space-y-0.5">{pinned.map((p) => row(p, "pushPin"))}</ul>
        </div>
      )}
      {others.length > 0 && (
        <div>
          <h2 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide opacity-60">
            {t.recent}
          </h2>
          <ul className="space-y-0.5">{others.map((p) => row(p, "clock"))}</ul>
        </div>
      )}
    </div>
  );
}
