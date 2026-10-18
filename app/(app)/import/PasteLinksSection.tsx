"use client";

import { useMemo, useState } from "react";
import { extractLinks } from "@/lib/extract-urls";

/**
 * Paste anything with links in it — a markdown list, a chat log, an email, a
 * bare list — and turn each link into a card.
 *
 * Extraction happens client-side so the count is live as you type and you see
 * exactly what will be created before committing. The server validates again;
 * this preview is a courtesy, not the gate.
 */

/** Matches the endpoint's per-request ceiling. */
const CHUNK = 500;

type Outcome = { created: number; existed: number; failed: number; rejected: string[] };

export default function PasteLinksSection({ isLoggedIn }: { isLoggedIn: boolean }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const links = useMemo(() => extractLinks(text), [text]);
  const titled = links.filter((l) => l.title).length;

  async function handleImport() {
    if (!links.length || !isLoggedIn) return;
    setStatus("loading");
    setError(null);
    setOutcome(null);
    const total: Outcome = { created: 0, existed: 0, failed: 0, rejected: [] };
    try {
      for (let i = 0; i < links.length; i += CHUNK) {
        const res = await fetch("/api/fsrs/batch-add", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: links.slice(i, i + CHUNK) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Import failed (${res.status})`);
        total.created += data.created ?? 0;
        total.existed += data.existed ?? 0;
        total.failed += data.failed ?? 0;
        total.rejected.push(...(data.rejected ?? []));
      }
      setOutcome(total);
      setStatus("done");
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setStatus("error");
    }
  }

  return (
    <div className="mt-10 border-t pt-8">
      <h2 className="text-2xl font-bold mb-2">Paste links</h2>
      <p className="text-gray-600 dark:text-gray-400 mb-6">
        Drop in anything with links in it — a markdown list, a chat log, an email. Each link becomes
        a card; <code>[title](url)</code> keeps its title. Links you already have are skipped.
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        spellCheck={false}
        placeholder={
          "- [Two-sum](https://leetcode.com/problems/two-sum/)\nhttps://www.youtube.com/watch?v=…\nsee also <https://example.com/x>"
        }
        className="w-full rounded-lg border border-gray-300 bg-white p-3 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleImport}
          disabled={!isLoggedIn || status === "loading" || links.length === 0}
          title={isLoggedIn ? undefined : "Sign in to import"}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "loading"
            ? "Importing…"
            : `Import ${links.length} link${links.length === 1 ? "" : "s"}`}
        </button>
        {text && (
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {links.length === 0
              ? "No links found yet."
              : `${links.length} unique link${links.length === 1 ? "" : "s"}` +
                (titled ? ` · ${titled} with a title` : "")}
          </span>
        )}
      </div>

      {!isLoggedIn && (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Sign in to import — cards are created in your cloud account.
        </p>
      )}

      {status === "done" && outcome && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm dark:border-green-800 dark:bg-green-900/20">
          <p className="font-medium text-green-800 dark:text-green-300">
            {outcome.created} new card{outcome.created === 1 ? "" : "s"}
            {outcome.existed > 0 && ` · ${outcome.existed} already in your deck`}
            {outcome.failed > 0 && ` · ${outcome.failed} failed`}
          </p>
          {outcome.rejected.length > 0 && (
            <p className="mt-1 text-gray-600 dark:text-gray-400">
              Not urls, skipped: {outcome.rejected.slice(0, 5).join(", ")}
              {outcome.rejected.length > 5 && ` and ${outcome.rejected.length - 5} more`}
            </p>
          )}
        </div>
      )}

      {status === "error" && error && (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
