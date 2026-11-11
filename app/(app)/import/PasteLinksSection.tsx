"use client";
import { useSignedIn } from "@/app/components/BoxApiBridge";

import { useMemo, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { extractLinks } from "@/lib/extract-urls";
import { around, fill, text as str } from "./text";

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

export default function PasteLinksSection({ isLoggedIn: serverSignedIn }: { isLoggedIn: boolean }) {
  // On a box, from lianki.com (BoxApiBridge); else the server's answer.
  const isLoggedIn = useSignedIn(serverSignedIn);
  const t = useIntlayer("import-sections");
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Which translated line explains the failure; the server's text stays in the console.
  const [error, setError] = useState<"linksSignIn" | "linksError" | null>(null);

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
        if (!res.ok) {
          console.warn("[import] batch-add failed", res.status, await res.text().catch(() => ""));
          setError(res.status === 401 ? "linksSignIn" : "linksError");
          setStatus("error");
          return;
        }
        const data = await res.json();
        total.created += data.created ?? 0;
        total.existed += data.existed ?? 0;
        total.failed += data.failed ?? 0;
        total.rejected.push(...(data.rejected ?? []));
      }
      setOutcome(total);
      setStatus("done");
      setText("");
    } catch (err) {
      console.warn("[import] batch-add failed", err);
      setError("linksError");
      setStatus("error");
    }
  }

  return (
    <div className="mt-10 border-t pt-8">
      <h2 className="text-2xl font-bold mb-2">{t.linksHeading}</h2>
      <p className="text-gray-600 dark:text-gray-400 mb-6">
        {around(t.linksIntro, "code")[0]}
        <code>[title](url)</code>
        {around(t.linksIntro, "code")[1]}
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        spellCheck={false}
        placeholder={str(t.linksPlaceholder)}
        className="w-full rounded-lg border border-gray-300 bg-white p-3 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleImport}
          disabled={!isLoggedIn || status === "loading" || links.length === 0}
          title={isLoggedIn ? undefined : str(t.linksSignInHint)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "loading" ? t.importing : fill(t.linksImport, { n: links.length })}
        </button>
        {text && (
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {links.length === 0
              ? t.linksNone
              : fill(t.linksFound, { n: links.length }) +
                (titled ? ` · ${fill(t.linksTitled, { n: titled })}` : "")}
          </span>
        )}
      </div>

      {!isLoggedIn && (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t.linksSignIn}</p>
      )}

      {status === "done" && outcome && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm dark:border-green-800 dark:bg-green-900/20">
          <p className="font-medium text-green-800 dark:text-green-300">
            {fill(t.linksNew, { n: outcome.created })}
            {outcome.existed > 0 && ` · ${fill(t.linksExisted, { n: outcome.existed })}`}
            {outcome.failed > 0 && ` · ${fill(t.linksFailed, { n: outcome.failed })}`}
          </p>
          {outcome.rejected.length > 0 && (
            <p className="mt-1 text-gray-600 dark:text-gray-400">
              {fill(t.linksRejected, {
                list:
                  outcome.rejected.slice(0, 5).join(", ") +
                  (outcome.rejected.length > 5
                    ? ` ${fill(t.linksMore, { n: outcome.rejected.length - 5 })}`
                    : ""),
              })}
            </p>
          )}
        </div>
      )}

      {status === "error" && error && (
        <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
          {t[error]}
        </p>
      )}
    </div>
  );
}
