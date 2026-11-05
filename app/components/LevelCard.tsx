/**
 * The learner level card on /profile (docs/levels.md, "Showing it"): the
 * 96px badge, the level name from the locale's ladder, study days so far, the
 * way to the next level, and the row of all six levels, the ones not reached
 * yet drawn faint. Presentational: the page decides who sees it (`levelsOn`)
 * and reads the level on the server.
 */
import Link from "next/link";
import type { LevelId } from "@/lib/levels";
import { LEVEL_IDS } from "@/lib/levels";
import {
  isLocked,
  levelProgress,
  progressText,
  type LevelView,
  type ProgressLabels,
} from "@/lib/level-progress";
import { LevelBadge } from "./level-badge";

export type LevelCardLabels = ProgressLabels & {
  cardTitle: string;
  studyDays: string;
  studyDaysHow: string;
  ladderLabel: string;
  lockedLabel: string;
  currentLabel: string;
};

export function LevelCard({
  view,
  names,
  labels,
  locale,
}: {
  view: LevelView;
  names: Record<LevelId, string>;
  labels: LevelCardLabels;
  locale: string;
}) {
  const p = levelProgress(view);
  const text = progressText(p, labels, names, locale);
  const href = p.kind === "signup" ? "/sign-in" : p.kind === "pro" ? "/membership" : null;
  const showDays = view.tier === "paid" || view.studyDays > 0;
  return (
    <section
      data-level-card
      aria-labelledby="level-card-title"
      className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6"
    >
      <h2 id="level-card-title" className="text-2xl font-semibold mb-4">
        {labels.cardTitle}
      </h2>
      <div className="flex items-center gap-5">
        <LevelBadge
          level={view.level}
          size={96}
          label={names[view.level]}
          className="shrink-0 text-[oklch(0.25_0.02_60)] dark:text-[oklch(0.92_0.02_82)]"
        />
        <div className="min-w-0 space-y-1.5">
          <p className="text-2xl font-bold" data-level-name>
            {names[view.level]}
          </p>
          {showDays && (
            <p className="text-sm">
              {labels.studyDays.replace("{n}", view.studyDays.toLocaleString(locale))}
            </p>
          )}
          {href ? (
            <Link
              href={href}
              data-level-progress
              className="inline-block text-sm font-medium text-[var(--brand)] underline underline-offset-2 hover:opacity-80"
            >
              {text}
            </Link>
          ) : (
            <p data-level-progress className="text-sm font-medium">
              {text}
            </p>
          )}
        </div>
      </div>
      {showDays && (
        <p className="mt-3 text-xs text-[oklch(0.5_0.02_60)] dark:text-[oklch(0.72_0.02_82)]">
          {labels.studyDaysHow}
        </p>
      )}
      <ol
        aria-label={labels.ladderLabel}
        className="mt-5 grid grid-cols-6 gap-1 text-[oklch(0.25_0.02_60)] dark:text-[oklch(0.92_0.02_82)]"
      >
        {LEVEL_IDS.map((id) => {
          const locked = isLocked(id, view.level);
          const current = id === view.level;
          const name = names[id];
          const label = current
            ? labels.currentLabel.replace("{level}", name)
            : locked
              ? labels.lockedLabel.replace("{level}", name)
              : name;
          return (
            <li
              key={id}
              aria-label={label}
              aria-current={current ? "step" : undefined}
              className={`flex flex-col items-center gap-1 rounded-md py-1.5 ${
                current
                  ? "bg-[oklch(0.53_0.207_22.3/0.1)] dark:bg-[oklch(0.6_0.205_18.3/0.16)]"
                  : ""
              }`}
            >
              <LevelBadge level={id} size={32} locked={locked} />
              <span
                aria-hidden="true"
                className={`text-[11px] leading-tight text-center truncate max-w-full ${
                  locked ? "opacity-40" : current ? "font-semibold" : ""
                }`}
              >
                {name}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
