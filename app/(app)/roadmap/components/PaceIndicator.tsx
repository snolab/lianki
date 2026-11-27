"use client";

/**
 * Whether the learner's own pace makes their target date: four states side
 * by side, all always visible (docs/design-principles.md, "A switch shows
 * all its states"): on pace, ahead, behind, no data. The active one is
 * filled seal red; the rest stay grey with a dashed outline. Without a
 * target date none is active and the line below invites setting one.
 */
import type { PaceState, PaceVerdict } from "@/lib/roadmap/eta";

export const PACE_STATES: readonly PaceState[] = ["on-pace", "ahead", "behind", "no-data"];

/** The highlighted state, or null (no target date yet). */
export const activeState = (v: PaceVerdict): PaceState | null =>
  v.state === "no-target" ? null : v.state;

export default function PaceIndicator({
  verdict,
  labels,
  label,
  detail,
}: {
  verdict: PaceVerdict;
  labels: Record<PaceState, string>;
  label: string;
  detail: string;
}) {
  const active = activeState(verdict);
  return (
    <div data-pace={verdict.state} className="mt-3">
      <ul role="list" aria-label={label} className="grid grid-cols-4 gap-1 text-xs sm:text-sm">
        {PACE_STATES.map((s) => {
          const on = s === active;
          return (
            <li
              key={s}
              data-pace-state={s}
              aria-current={on ? "true" : undefined}
              className={`flex min-h-10 items-center justify-center rounded-lg px-1 text-center font-medium ${
                on
                  ? "bg-primary text-on-primary"
                  : "border border-dashed border-gray-300 text-gray-500 dark:border-gray-600 dark:text-gray-400"
              }`}
            >
              {labels[s]}
            </li>
          );
        })}
      </ul>
      <p data-pace-detail className="mt-2 text-sm text-gray-700 dark:text-gray-300">
        {detail}
      </p>
    </div>
  );
}
