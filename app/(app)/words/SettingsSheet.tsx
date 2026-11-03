"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/app/components/icons";
import { useBackToClose } from "@/lib/use-back-to-close";

/**
 * The /words study settings, as a modal: a bottom sheet on a phone, a centred
 * dialog from 40rem up (docs/design-principles.md). One glass layer; a title
 * row that stays put while the body scrolls inside itself, bounded by the
 * visible viewport (keyboard and browser bars included), so the last row is
 * always reachable. Closes by the ✕, a swipe down on the handle or title, a
 * tap on the scrim, Esc, or back. Focus stays inside while open and returns
 * to `returnTo` on close.
 */
export function SettingsSheet({
  title,
  label,
  closeLabel,
  onClose,
  onScrimTap,
  returnTo,
  children,
}: {
  title: ReactNode;
  /** The dialog's screen-reader name. */
  label: string;
  closeLabel: string;
  onClose: () => void;
  /** A tap on the scrim, with where it landed (before it closes the sheet). */
  onScrimTap?: (x: number, y: number) => void;
  returnTo: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useBackToClose(true, () => close.current());
  const vv = useVisibleViewport();

  // Focus in on open, back to the Settings button on close.
  useLayoutEffect(() => {
    const back = returnTo.current;
    panel.current?.focus({ preventScroll: true });
    return () => back?.focus({ preventScroll: true });
  }, [returnTo]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      // Focus trap: Tab and Shift+Tab cycle inside the sheet.
      const items = [
        ...panel.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (items.length === 0) return e.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      const inside = panel.current.contains(at);
      if (e.shiftKey && (at === first || !inside || at === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // Swipe down on the handle or the title row: the sheet follows the finger,
  // and closes past 80 px or on a quick flick.
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const setShift = (dy: number, animate: boolean) => {
    const el = panel.current;
    if (!el) return;
    el.style.transition = animate ? "translate 200ms var(--min-jerk)" : "none";
    el.style.translate = dy > 0 ? `0 ${dy}px` : "";
  };
  const grip = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      drag.current = { y: e.clientY, t: performance.now(), dy: 0 };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      d.dy = Math.max(0, e.clientY - d.y);
      setShift(d.dy, false);
    },
    onPointerUp: () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      const speed = d.dy / Math.max(1, performance.now() - d.t);
      if (d.dy > 80 || (d.dy > 20 && speed > 0.5)) close.current();
      else setShift(0, true);
    },
    onPointerCancel: () => {
      drag.current = null;
      setShift(0, true);
    },
  };

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex items-end justify-center sm:items-center sm:p-8"
      // The visible viewport: above an on-screen keyboard, inside the browser's bars.
      style={{ height: vv.height || "100dvh", top: vv.top }}
      data-words-settings-dialog
    >
      <div
        className="absolute inset-0 bg-black/30 lk-fade-in"
        onClick={(e) => {
          onScrimTap?.(e.clientX, e.clientY);
          close.current();
        }}
        data-words-settings-scrim
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-words-settings
        className="lk-settings-panel lk-glass relative flex w-full flex-col rounded-t-2xl text-sm shadow-[0_-8px_30px_oklch(0_0_0/0.25)] outline-none sm:max-w-xl sm:rounded-2xl sm:shadow-[0_12px_40px_oklch(0_0_0/0.25)]"
      >
        <div className="shrink-0 touch-none select-none px-4 pt-2 pb-2 sm:pt-3" {...grip}>
          <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-current opacity-20 sm:hidden" />
          <div className="flex items-center gap-2">
            <h2 className="flex-1 font-medium">{title}</h2>
            <button
              className="tap-40 -me-1 rounded-full px-2 py-1 opacity-70 hover:opacity-100"
              onClick={() => close.current()}
              aria-label={closeLabel}
              data-words-settings-close
            >
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-4"
          data-words-settings-body
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** The visible viewport's height and top (visualViewport), on its own events. */
function useVisibleViewport() {
  const [vp, setVp] = useState({ height: 0, top: 0 });
  useLayoutEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const fit = () =>
      setVp((p) => {
        const n = { height: Math.round(v.height), top: Math.round(v.offsetTop) };
        return p.height === n.height && p.top === n.top ? p : n;
      });
    fit();
    v.addEventListener("resize", fit);
    v.addEventListener("scroll", fit);
    return () => {
      v.removeEventListener("resize", fit);
      v.removeEventListener("scroll", fit);
    };
  }, []);
  return vp;
}
