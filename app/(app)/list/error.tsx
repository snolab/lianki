"use client";

import { useEffect } from "react";
import { useIntlayer } from "next-intlayer";

/**
 * /list's error boundary: a plain, translated card. The error's message and
 * digest go to the console only (owner, 2026-11-10: no internals in the UI).
 */
export default function ListError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useIntlayer("list-ui").error;
  useEffect(() => {
    console.error("[list] page error:", error.message, error.digest ?? "");
  }, [error]);
  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div
        role="alert"
        className="max-w-xl w-full bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6"
      >
        <h2 className="text-xl font-bold text-red-800 dark:text-red-200 mb-2">{t.title}</h2>
        <p className="text-sm text-red-700 dark:text-red-300 mb-4">{t.text}</p>
        <button
          onClick={reset}
          className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700"
        >
          {t.retry}
        </button>
      </div>
    </div>
  );
}
