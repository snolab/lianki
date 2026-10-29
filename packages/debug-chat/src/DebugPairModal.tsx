"use client";

import { useEffect, useState } from "react";
import { type PageInfo, type PairInfo, allowLabel, pageParts, pairSentence } from "./wire";

/**
 * The pairing request, as a modal on every open page of its audience (both
 * devices; answering on one closes it everywhere, since the hub broadcasts
 * the state). It lists the audience's open pages with a checkbox each, this
 * one ticked; Allow grants exactly the pages ticked — or "all" (every page,
 * also those opened later) when all are. docs/monitoring.md, "Remote eval".
 */
export function DebugPairModal({
  pending,
  friend,
  pages,
  selfPage,
  onAllow,
  onDeny,
}: {
  pending: PairInfo;
  friend: boolean;
  pages: PageInfo[];
  selfPage?: string;
  onAllow: (pages: string[] | "all") => void;
  onDeny: () => void;
}) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(selfPage ? [selfPage] : []));
  // A new request starts again from "this page only".
  useEffect(() => setTicked(new Set(selfPage ? [selfPage] : [])), [pending.pair, selfPage]);
  const ids = pages.map((p) => p.id).filter(Boolean);
  const all = ids.length > 0 && ids.every((id) => ticked.has(id));
  const toggle = (id: string) =>
    setTicked((t) => {
      const n = new Set(t);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  // A hub from before page lists sends none: Allow then means all, as it did.
  const allow = () => onAllow(ids.length === 0 || all ? "all" : ids.filter((id) => ticked.has(id)));
  const count = ids.filter((id) => ticked.has(id)).length;

  return (
    <div
      data-testid="debug-modal"
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "oklch(0.1 0 0 / 0.7)" }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="debug-modal-title"
        className="flex max-h-[90vh] min-h-[50vh] w-[min(30rem,100%)] flex-col gap-4 rounded-2xl p-5 shadow-2xl"
        style={{
          background: "oklch(0.22 0.02 260)",
          color: "oklch(0.97 0 0)",
          minHeight: "50vh",
          maxHeight: "90vh",
        }}
      >
        <p id="debug-modal-title" className="text-lg leading-snug">
          {pairSentence(pending, friend)}
          {!friend && ids.length > 1 && " Authorize this page only, or more?"}
        </p>
        <p className="text-sm" style={{ color: "oklch(0.8 0.01 260)" }}>
          Code{" "}
          <b data-testid="debug-modal-code" className="font-mono text-5xl tracking-widest">
            {pending.code}
          </b>
          <br />
          {friend
            ? "Allow only if the agent told you this code in the chat."
            : "Allow only if your terminal shows the same code."}
        </p>
        {ids.length > 0 && (
          // Only the list scrolls; the sentence, the code and the buttons stay put.
          <ul
            data-testid="debug-modal-pages"
            className="min-h-0 flex-1 overflow-y-auto rounded-lg"
            style={{ background: "oklch(0.27 0.02 260)", maxHeight: "40vh" }}
          >
            {pages.map((pg) => {
              const { path, device } = pageParts(pg.label);
              const self = pg.id === selfPage;
              return (
                <li key={pg.id || pg.label}>
                  <label
                    className="flex min-h-12 items-center gap-3 px-3 py-2"
                    style={{ minHeight: 48 }}
                  >
                    <input
                      type="checkbox"
                      data-testid="debug-modal-page-check"
                      data-page-id={pg.id}
                      disabled={!pg.id}
                      checked={ticked.has(pg.id)}
                      onChange={() => toggle(pg.id)}
                      className="size-5 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-base">{path}</span>
                    <span className="shrink-0 text-xs" style={{ color: "oklch(0.75 0.01 260)" }}>
                      {[device, self ? "this page" : ""].filter(Boolean).join(" · ")}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-auto flex flex-col gap-2">
          <button
            type="button"
            data-testid="debug-modal-allow"
            disabled={ids.length > 0 && count === 0}
            onClick={allow}
            className="min-h-14 rounded-xl px-4 text-lg font-medium disabled:opacity-40"
            style={{ background: "oklch(0.55 0.15 145)", minHeight: 56 }}
          >
            {ids.length === 0
              ? "Authorize"
              : allowLabel(count, ids.length, ticked.has(selfPage ?? ""))}
          </button>
          {ids.length > 1 && !all && (
            <button
              type="button"
              data-testid="debug-modal-allow-all"
              onClick={() => onAllow("all")}
              className="min-h-12 rounded-xl px-4 text-base"
              style={{ background: "oklch(0.4 0.08 145)", minHeight: 48 }}
            >
              Authorize all pages
            </button>
          )}
          <button
            type="button"
            data-testid="debug-modal-deny"
            onClick={onDeny}
            className="min-h-14 rounded-xl px-4 text-lg"
            style={{ background: "oklch(0.4 0.02 260)", minHeight: 56 }}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
