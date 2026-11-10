"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * A modal pop-up: a bottom sheet on a phone, a centred dialog from `sm` up
 * (docs/design-principles.md: modals say so with role="dialog", aria-modal
 * and Escape). Labelled by its heading; Tab stays inside it; Escape, the ×
 * and a tap on the backdrop close it; focus goes back to what opened it.
 *
 * Its content stays mounted while closed (hidden), so a form keeps what was
 * typed and a child's on-load work (a return from Google's consent screen)
 * still runs. No `inert` on the page and no focus pulling: Google's Picker
 * opens over it, outside it, and must stay usable.
 */
export function ModalSheet(p: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Screen-reader label of the × button. */
  closeLabel: string;
  testId?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!p.open || !mounted) return;
    const el = panel.current;
    if (!el) return;
    const opener = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      if (el.contains(document.activeElement)) return;
      (el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(el)[0] ?? el).focus();
    });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables(el);
      if (!f.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [p.open, mounted]);

  if (!mounted) return null;
  return createPortal(
    <div
      hidden={!p.open}
      className="fixed inset-0 z-[var(--lk-z-overlay)]"
      data-testid={p.testId ? `${p.testId}-layer` : undefined}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[oklch(0.15_0.01_65/0.5)]"
        onClick={() => close.current()}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={p.testId}
        className="lk-sheet absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-[oklch(0.5_0.02_65/0.25)] px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] text-[var(--foreground)] shadow-xl outline-none sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(32rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-5"
      >
        {/* The grab bar says "sheet" on a phone; it is not a drag handle. */}
        <div
          aria-hidden="true"
          className="mx-auto mb-2 h-1 w-10 rounded-full bg-[oklch(0.5_0.02_65/0.35)] sm:hidden"
        />
        <div className="flex items-center gap-2 mb-3">
          <h2 id={titleId} className="flex-1 min-w-0 text-lg font-semibold">
            {p.title}
          </h2>
          <button
            type="button"
            onClick={() => close.current()}
            aria-label={p.closeLabel}
            data-testid={p.testId ? `${p.testId}-close` : undefined}
            className="lk-btn lk-btn-quiet -me-2 size-11 p-0 text-xl leading-none"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        {p.children}
      </div>
    </div>,
    document.body,
  );
}
