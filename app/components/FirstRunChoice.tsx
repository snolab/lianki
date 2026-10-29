"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FIRST_RUN_KEY, parseChoice, shouldAsk, type FirstRunChoice } from "@/lib/first-run";

export type FirstRunLabels = {
  title: string;
  body: string;
  useLocally: string;
  createAccount: string;
  syncFree: string;
  switchLater: string;
};

/**
 * Asks a first-time, signed-out visitor whether to use Lianki on this device or
 * with an account. The decision of *when* to ask lives in lib/first-run.ts.
 *
 * Every localStorage access is wrapped: a private window or blocked site data
 * makes the accessor throw, and a prompt that crashes the shell is worse than
 * one that asks twice.
 */
export function FirstRunChoice({ labels }: { labels: FirstRunLabels }) {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [stored, setStored] = useState<FirstRunChoice | null>(null);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      setStored(parseChoice(localStorage.getItem(FIRST_RUN_KEY)));
    } catch {
      // Unreadable storage: treat as unanswered rather than failing to render.
    }
    setMounted(true);
  }, []);

  const open = shouldAsk({ signedIn: false, pathname, stored, mounted });

  // Focus the non-committal option, not the sign-in link: a stray Enter should
  // not send someone to an auth flow they never asked for.
  useEffect(() => {
    if (open) primary.current?.focus();
  }, [open]);

  function record(choice: FirstRunChoice) {
    try {
      localStorage.setItem(FIRST_RUN_KEY, choice);
    } catch {
      // Not persisted — they will be asked again next visit. Acceptable.
    }
    setStored(choice);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      // Dismissing without choosing means "not now", which is the local path:
      // they keep using the app exactly as they already were.
      onClick={() => record("local")}
      onKeyDown={(e) => {
        if (e.key === "Escape") record("local");
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lk-first-run-title"
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="lk-first-run-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {labels.title}
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{labels.body}</p>
        <p className="mt-1 text-sm font-medium text-green-700 dark:text-green-400">
          {labels.syncFree}
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <Link
            href="/sign-in"
            onClick={() => record("account")}
            className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-center text-sm font-medium text-white hover:bg-blue-700"
          >
            {labels.createAccount}
          </Link>
          <button
            ref={primary}
            type="button"
            onClick={() => record("local")}
            className="flex-1 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {labels.useLocally}
          </button>
        </div>

        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{labels.switchLater}</p>
      </div>
    </div>
  );
}
