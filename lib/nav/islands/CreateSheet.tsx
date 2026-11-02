"use client";

/**
 * Create (docs/bottom-nav.md): import anything. A glass sheet over the
 * bottom island, opened by the centre button (a tap, or a long press in
 * debug mode). Modal: role="dialog", Escape or the backdrop closes it.
 */
import { useEffect, useRef } from "react";
import { Icon, type IconName } from "@/app/components/icons";
import { createItems } from "./SearchPalette";
import type { NavText } from "./text";

const ICON: Record<string, IconName> = {
  "create:deck": "textAa",
  "create:link": "link",
  "create:import": "uploadSimple",
  "create:ai": "sparkle",
};

export function CreateSheet({
  open,
  onClose,
  onPick,
  t,
  bottom,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (href: string) => void;
  t: NavText;
  /** The island's docked bottom (px), so the sheet opens just above it. */
  bottom?: string;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    first.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={t.create} className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={t.close}
        onClick={onClose}
        className="absolute inset-0 bg-[oklch(0.2_0.01_65/0.22)] dark:bg-[oklch(0_0_0/0.4)]"
      />
      <div
        className="lk-glass absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] mx-auto max-w-md overflow-hidden rounded-3xl border border-[var(--glass-line)] p-1.5 shadow-[inset_0_1px_0_oklch(1_0_0/0.5),0_20px_50px_-12px_oklch(0.22_0.015_65/0.45)] dark:shadow-[inset_0_1px_0_oklch(1_0_0/0.1),0_20px_50px_-12px_oklch(0_0_0/0.7)]"
        style={bottom ? { bottom: `calc(${bottom} + 4.5rem)` } : undefined}
      >
        <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide opacity-60">
          {t.create}
        </div>
        {createItems(t).map((it, i) => (
          <button
            key={it.id}
            ref={i === 0 ? first : undefined}
            type="button"
            onClick={() => onPick(it.href)}
            className="flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-start hover:bg-[oklch(from_var(--foreground)_l_c_h/0.06)] focus-visible:bg-[oklch(from_var(--foreground)_l_c_h/0.06)] focus-visible:outline-none"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[oklch(from_var(--brand)_l_c_h/0.14)] text-lg text-[var(--brand)]">
              <Icon name={ICON[it.id] ?? "plus"} />
            </span>
            <span className="min-w-0 flex-1 truncate">{it.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
