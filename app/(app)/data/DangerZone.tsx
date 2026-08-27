"use client";

import { useState } from "react";

type Props = {
  heading: string;
  wipeLocalLabel: string;
  deleteAllLabel: string;
  confirmHint: string;
  isLoggedIn: boolean;
  localCount: number;
  cloudCount: number | null;
  onWipeLocal: () => Promise<string>;
  onDeleteAllCloud: () => Promise<string>;
};

const CONFIRM_WORD = "DELETE";

export default function DangerZone({
  heading,
  wipeLocalLabel,
  deleteAllLabel,
  confirmHint,
  isLoggedIn,
  localCount,
  cloudCount,
  onWipeLocal,
  onDeleteAllCloud,
}: Props) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<null | "local" | "cloud">(null);
  const [message, setMessage] = useState<string | null>(null);
  const armed = confirm === CONFIRM_WORD;

  async function run(which: "local" | "cloud", action: () => Promise<string>) {
    setBusy(which);
    setMessage(null);
    try {
      setMessage(await action());
      setConfirm("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-labelledby="danger-heading"
      className="rounded-lg border border-red-200 dark:border-red-900 p-4"
    >
      <h2 id="danger-heading" className="text-xl font-semibold text-red-700 dark:text-red-300 mb-1">
        {heading}
      </h2>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        These cannot be undone. Export a backup first.
      </p>

      <label className="block mb-4 text-sm">
        <span className="block mb-1 text-gray-600 dark:text-gray-400">{confirmHint}</span>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={CONFIRM_WORD}
          className="w-40 rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-3 py-1.5 font-mono"
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!armed || busy !== null || localCount === 0}
          onClick={() => run("local", onWipeLocal)}
          className="rounded-lg border border-red-300 dark:border-red-800 px-4 py-2 text-sm font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          🗑 {wipeLocalLabel} ({localCount})
        </button>
        <button
          type="button"
          disabled={!armed || busy !== null || !isLoggedIn || !cloudCount}
          onClick={() => run("cloud", onDeleteAllCloud)}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          🗑 {deleteAllLabel}
          {cloudCount == null ? "" : ` (${cloudCount})`}
        </button>
      </div>

      {message && <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">{message}</p>}

      <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
        Wiping Local clears only this browser&apos;s mirror — the userscript&apos;s own store is
        untouched and will repopulate it on the next visit. Clear that from the userscript menu.
      </p>
    </section>
  );
}
