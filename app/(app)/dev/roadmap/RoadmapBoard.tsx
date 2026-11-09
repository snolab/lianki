"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { compactTime, isLate } from "@lianki/debug-chat/eta";
import { progressSocketUrl } from "@/lib/progress-tree";
import {
  ROADMAP_SECTIONS,
  type RoadmapItem,
  type RoadmapSection,
  type RoadmapState,
  roadmapSections,
  roadmapSource,
  sectionCount,
} from "@/lib/roadmap-tree";

export type RoadmapLabels = {
  toc: string;
  stateTree: string;
  sections: Record<RoadmapSection, string>;
  connecting: string;
  empty: string;
};

const ACCENT: Record<RoadmapSection, string> = {
  doing: "border-s-blue-600",
  waiting: "border-s-amber-500",
  queued: "border-s-gray-500",
  done: "border-s-green-600",
};
const LINK = "text-blue-700 dark:text-blue-300 hover:underline";

/** A done item's day, in JST and unambiguous (ISO). */
const dayJst = (at: number) => new Date(at + 9 * 3_600_000).toISOString().slice(0, 10);

/**
 * The board: open nodes of the state tree by section and top-level path, and
 * the done history (folded). Titles are the nodes' own, shown as written.
 * `header` heads the main column; `tree` (the live tree) sits between the
 * contents and the sections.
 */
export function RoadmapBoard({
  labels,
  header,
  tree,
}: {
  labels: RoadmapLabels;
  header: ReactNode;
  tree: ReactNode;
}) {
  const [state, setState] = useState<RoadmapState>({
    rows: [],
    history: [],
    live: false,
    loaded: false,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => roadmapSource({ url: progressSocketUrl(location) }, setState), []);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [state]);
  const board = useMemo(() => roadmapSections(state.rows, state.history), [state]);

  const tocLinks = (
    <ol className="space-y-1 text-sm">
      <li>
        <a href="#tree" className={LINK}>
          {labels.stateTree}
        </a>
      </li>
      {ROADMAP_SECTIONS.map((s) => (
        <li key={s} className="flex items-baseline justify-between gap-2">
          <a href={`#${s}`} className={LINK}>
            {labels.sections[s]}
          </a>
          <span className="tabular-nums opacity-70">{sectionCount(board[s])}</span>
        </li>
      ))}
    </ol>
  );

  const item = (it: RoadmapItem, s: RoadmapSection) => (
    <li
      key={it.id}
      className={`rounded-xl border border-black/10 dark:border-white/10 border-s-4 ${ACCENT[s]} bg-white/60 dark:bg-gray-900/60 px-4 py-3`}
      data-node={it.id}
    >
      <p className="font-medium leading-snug" dir="auto">
        {it.title}
      </p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm tabular-nums">
        <span className="opacity-60 break-all">{it.id}</span>
        {s === "done" && <span className="opacity-60">{dayJst(it.at)}</span>}
        {s !== "done" && it.etaAt !== undefined && (
          <span className={isLate(it.etaAt - now) ? "text-red-700 dark:text-red-300" : ""}>
            {compactTime(it.etaAt - now)}
          </span>
        )}
        {it.prs.map((pr) => (
          <a
            key={pr}
            href={`https://github.com/snolab/lianki/pull/${pr}`}
            className={LINK}
            target="_blank"
            rel="noreferrer"
          >
            #{pr}
          </a>
        ))}
      </p>
      {it.needs && (
        <p className="mt-1 text-sm" dir="auto">
          {it.needs}
        </p>
      )}
      {it.link && (
        <a
          href={it.link}
          className={`mt-1 inline-block text-sm break-all ${LINK}`}
          target="_blank"
          rel="noreferrer"
        >
          {it.link.replace(/^https?:\/\//, "")}
        </a>
      )}
    </li>
  );

  const groups = (s: RoadmapSection) =>
    board[s].length === 0 ? (
      <p className="text-sm opacity-70">{state.live ? labels.empty : labels.connecting}</p>
    ) : (
      <div className="space-y-4">
        {board[s].map((g) => (
          <div key={g.top} className="space-y-2" data-top={g.top}>
            <h3 className="text-sm font-semibold opacity-75">{g.top}</h3>
            <ul className="space-y-2">{g.items.map((it) => item(it, s))}</ul>
          </div>
        ))}
      </div>
    );

  return (
    <>
      <aside className="hidden lg:block">
        <nav aria-label={labels.toc} className="sticky top-4 space-y-2" data-roadmap-toc>
          <h2 className="text-xs font-semibold uppercase tracking-wide opacity-70">{labels.toc}</h2>
          {tocLinks}
        </nav>
      </aside>
      <div className="min-w-0 space-y-10">
        {header}
        <details className="lg:hidden rounded-xl border border-black/10 dark:border-white/10 px-4 py-2">
          <summary className="cursor-pointer text-sm font-semibold">{labels.toc}</summary>
          <nav aria-label={labels.toc} className="pt-2 pb-1">
            {tocLinks}
          </nav>
        </details>
        <div id="tree" className="scroll-mt-4">
          {tree}
        </div>
        {ROADMAP_SECTIONS.map((s) => {
          const heading = (
            <>
              {labels.sections[s]}
              <span className="text-sm opacity-70 tabular-nums">{sectionCount(board[s])}</span>
            </>
          );
          if (s === "done")
            // Folded; the id sits on <details>, so a contents link lands on its summary.
            return (
              <details key={s} id={s} className="scroll-mt-4 group" data-status={s}>
                <summary className="cursor-pointer font-antique text-xl flex items-baseline gap-2 list-none [&::-webkit-details-marker]:hidden">
                  <span
                    aria-hidden
                    className="inline-block transition-transform group-open:rotate-90"
                  >
                    ›
                  </span>
                  {heading}
                </summary>
                <div className="mt-3">{groups(s)}</div>
              </details>
            );
          return (
            <section key={s} id={s} className="scroll-mt-4 space-y-3" data-status={s}>
              <h2 className="font-antique text-xl flex items-baseline gap-2">{heading}</h2>
              {groups(s)}
            </section>
          );
        })}
      </div>
    </>
  );
}
