"use client";

import { useCallback, useState } from "react";
import type { HostGroup } from "@/app/lib/notesAdmin";

/**
 * Cards grouped by host, with a reachability check and a per-host delete.
 *
 * A retired site is invisible in a paginated card list. Reviewing one of its
 * cards is impossible — no content script runs on a browser error page — so the
 * card stays due and the next one is served in its place, with nothing on screen
 * connecting them. Cleaning up 75 such cards previously took database access.
 *
 * Reachability is checked one host at a time, on demand rather than on load: it
 * is a request per host to somebody else's server, and most people open this
 * page for other reasons.
 */

type Verdict = { reachable: boolean; status?: number; reason?: string };

type Props = {
  hosts: HostGroup[];
  loading: boolean;
  /** Deletes every card on the host, from the cloud and the userscript alike. */
  onDeleteHost: (host: string) => Promise<void>;
};

function VerdictBadge({ verdict }: { verdict: Verdict | "checking" | undefined }) {
  if (verdict === undefined) return null;
  if (verdict === "checking") return <span className="text-xs text-gray-400">checking…</span>;

  if (!verdict.reachable) {
    return (
      <span
        className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300"
        title={`No response (${verdict.reason})`}
      >
        unreachable
      </span>
    );
  }
  // A status is worth showing even when reachable: a wall of 403s or 404s is
  // usually a site that changed rather than one that died, and that is the
  // user's call to make, not ours.
  return (
    <span className="text-xs text-gray-500 dark:text-gray-400">
      {verdict.status ? `HTTP ${verdict.status}` : "reachable"}
    </span>
  );
}

export default function HostPanel({ hosts, loading, onDeleteHost }: Props) {
  const [verdicts, setVerdicts] = useState<Record<string, Verdict | "checking">>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async (group: HostGroup) => {
    setVerdicts((v) => ({ ...v, [group.host]: "checking" }));
    try {
      const res = await fetch(`/api/fsrs/probe?url=${encodeURIComponent(group.sampleUrl)}`);
      if (!res.ok) throw new Error(String(res.status));
      const verdict = (await res.json()) as Verdict;
      setVerdicts((v) => ({ ...v, [group.host]: verdict }));
    } catch {
      // A failed check says nothing about the host, so it must not read as one.
      setVerdicts((v) => {
        const { [group.host]: _dropped, ...rest } = v;
        return rest;
      });
      setError("Could not check that host — try again.");
    }
  }, []);

  async function remove(group: HostGroup) {
    if (
      !confirm(
        `Delete all ${group.count} card${group.count === 1 ? "" : "s"} on ${group.host}?\n\n` +
          `This removes them from the cloud, this browser, and the userscript's own store.`,
      )
    )
      return;
    setBusy(group.host);
    setError(null);
    try {
      await onDeleteHost(group.host);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  // Long tail of one-card hosts is noise; the sites worth cleaning are the ones
  // with several cards on them.
  const shown = expanded ? hosts : hosts.slice(0, 10);

  return (
    <section aria-labelledby="hosts-heading">
      <h2 id="hosts-heading" className="text-xl font-semibold mb-1">
        By site
      </h2>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        A site that has gone away leaves cards that cannot be reviewed or skipped. Check one here
        and clear the whole deck of it at once.
      </p>

      {error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading && hosts.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      ) : hosts.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No cards yet.</p>
      ) : (
        <>
          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
            {shown.map((g) => (
              <li key={g.host} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="font-mono text-sm break-all">{g.host}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {g.count} card{g.count === 1 ? "" : "s"}
                  {g.due > 0 && ` · ${g.due} due`}
                </span>
                <VerdictBadge verdict={verdicts[g.host]} />
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => void check(g)}
                    disabled={verdicts[g.host] === "checking"}
                    className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
                  >
                    Check
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(g)}
                    disabled={busy === g.host}
                    className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30"
                  >
                    {busy === g.host ? "Deleting…" : "Delete all"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {hosts.length > shown.length && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              Show all {hosts.length} sites
            </button>
          )}
        </>
      )}
    </section>
  );
}
