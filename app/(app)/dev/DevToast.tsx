"use client";

import { useEffect } from "react";
import { useIntlayer } from "next-intlayer";
import { Icon } from "@/app/components/icons";

export type DevToastMsg = { ok: boolean; text: string; id: number };

/** How long a saved toast stays (an error stays until dismissed). */
export const DEV_TOAST_MS = 6000;

/**
 * The toast after a change on a /dev page (/dev/flags, /dev/permissions):
 * what was saved and when it takes effect, or why it was not. Glass, above the
 * bottom bar and the safe area; an error carries a warning icon, never red
 * alone, and stays until closed.
 */
export function DevToast({ msg, onClose }: { msg: DevToastMsg | null; onClose: () => void }) {
  const s = useIntlayer("dev-flag-toast");
  useEffect(() => {
    if (!msg?.ok) return;
    const t = setTimeout(onClose, DEV_TOAST_MS);
    return () => clearTimeout(t);
  }, [msg, onClose]);
  return (
    <div
      role={msg && !msg.ok ? "alert" : "status"}
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[var(--lk-z-notice)] flex justify-center"
    >
      {msg && (
        <div
          key={msg.id}
          data-dev-toast={msg.ok ? "ok" : "error"}
          className={`pointer-events-auto flex max-w-md items-start gap-2 rounded-xl border px-3 py-2 text-sm shadow-lg backdrop-blur-md ${
            msg.ok
              ? "border-gray-500/20 bg-white/90 text-gray-900 dark:bg-gray-800/90 dark:text-gray-100"
              : "border-red-700/40 bg-[oklch(0.96_0.03_25/0.95)] text-[oklch(0.42_0.16_25)] dark:bg-[oklch(0.3_0.07_25/0.95)] dark:text-[oklch(0.9_0.06_25)]"
          }`}
        >
          {msg.ok ? (
            <Icon name="check" className="mt-0.5 text-blue-600 dark:text-blue-300" />
          ) : (
            <Icon name="warning" className="mt-0.5" />
          )}
          <span className="min-w-0 flex-1 break-words">{msg.text}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={s.dismiss.value}
            className="-me-1 -mt-0.5 grid size-7 shrink-0 place-items-center rounded-full opacity-70 hover:opacity-100"
          >
            <Icon name="x" />
          </button>
        </div>
      )}
    </div>
  );
}
