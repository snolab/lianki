"use client";

import { type EtaTask, etaSummary, shortLeft, shownTasks, taskFraction } from "./eta";
import type { ChatStrings } from "./wire";

/**
 * The ETA bar (eta.ts): one line above the chat input summing up every timed
 * task — overall progress weighted by the estimates, time left, and with
 * several, their count and when the next is due. A tap opens the state tree,
 * where EtaList shows each task. Nothing when there is no timed task.
 */

/** A tap on the bar must not take focus from the input (the keyboard stays). */
export const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

const TRACK = "oklch(0.6 0.02 260 / 0.25)";
const FILL = "oklch(0.62 0.14 250)";
const FILL_PAST = "oklch(0.68 0.16 60)";
const FILL_DONE = "oklch(0.64 0.15 150)";

/** A small clock, drawn here (no icon set): a ring and two hands. */
export function EtaClockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className="shrink-0"
    >
      <circle cx="8" cy="8" r="6.4" />
      <path d="M8 4.6V8l2.4 1.6" />
    </svg>
  );
}

type EtaText = Pick<
  ChatStrings,
  "etaTasks" | "etaLeft" | "etaNext" | "etaReached" | "etaDone" | "etaOpen" | "etaList"
>;

/** A thin bar, filled to `frac`. */
function Meter({ frac, color, testId }: { frac: number; color: string; testId?: string }) {
  return (
    <span
      aria-hidden
      data-testid={testId}
      className="relative inline-block h-1 min-w-8 flex-1 overflow-hidden rounded-full"
      style={{ background: TRACK }}
    >
      <span
        className="absolute inset-y-0 start-0 rounded-full transition-[width] duration-700 motion-reduce:transition-none"
        style={{ width: `${Math.round(frac * 100)}%`, background: color }}
      />
    </span>
  );
}

/** One task's state: done, past its estimate, or the time left. */
export function taskState(t: EtaTask, now: number, s: EtaText, lang?: string) {
  if (t.done) return s.etaDone;
  return t.at <= now ? s.etaReached : s.etaLeft.replace("{t}", shortLeft(t.at - now, lang));
}

/** The summary line's text: "Title · 25m left", or "3 tasks · 1h left · next in 5m". */
export function summaryText(tasks: readonly EtaTask[], now: number, s: EtaText, lang?: string) {
  const sum = etaSummary(tasks, now);
  if (!sum.count) return "";
  if (sum.only) return `${sum.only.title} · ${taskState(sum.only, now, s, lang)}`;
  const parts = [s.etaTasks.replace("{n}", String(sum.count))];
  if (sum.leftMs === null) parts.push(s.etaDone);
  else if (sum.leftMs <= 0) parts.push(s.etaReached);
  else parts.push(s.etaLeft.replace("{t}", shortLeft(sum.leftMs, lang)));
  if (sum.next && sum.open > 1 && sum.next.at < now + (sum.leftMs ?? 0))
    parts.push(s.etaNext.replace("{t}", shortLeft(sum.next.at - now, lang)));
  return parts.join(" · ");
}

export function EtaBar({
  tasks,
  now,
  strings,
  onOpen,
  lang,
}: {
  tasks: readonly EtaTask[];
  now: number;
  strings: EtaText;
  onOpen: () => void;
  lang?: string;
}) {
  const sum = etaSummary(tasks, now);
  if (!sum.count) return null;
  const past = sum.leftMs !== null && sum.leftMs <= 0;
  const text = summaryText(tasks, now, strings, lang);
  return (
    <button
      type="button"
      data-testid="debug-chat-eta-bar"
      data-count={sum.count}
      data-pct={sum.pct}
      aria-label={`${text} · ${sum.pct}% — ${strings.etaOpen}`}
      title={strings.etaOpen}
      onMouseDown={keepFocus}
      onClick={onOpen}
      className="pointer-events-auto mb-1 flex w-full min-w-0 items-center gap-1.5 border-0 bg-transparent px-2 py-0.5 text-start fs-10 text-inherit"
    >
      <EtaClockIcon />
      <Meter
        frac={sum.pct / 100}
        color={sum.leftMs === null ? FILL_DONE : past ? FILL_PAST : FILL}
        testId="debug-chat-eta-meter"
      />
      <span data-testid="debug-chat-eta-text" className="min-w-0 max-w-[70%] truncate opacity-75">
        {text}
      </span>
      <span className="tabular-nums opacity-60">{sum.pct}%</span>
    </button>
  );
}

/** The status area's list (top of the state tree panel): every timed task, its bar and time left. */
export function EtaList({
  tasks,
  now,
  strings,
  lang,
}: {
  tasks: readonly EtaTask[];
  now: number;
  strings: EtaText;
  lang?: string;
}) {
  const shown = shownTasks(tasks, now);
  if (!shown.length) return null;
  return (
    <section data-testid="debug-chat-eta-list" className="mb-1.5 min-w-0 fs-10">
      <h3 className="m-0 mb-0.5 flex items-center gap-1 fs-10 font-semibold opacity-70">
        <EtaClockIcon size={11} />
        {strings.etaList}
      </h3>
      <ul className="m-0 list-none space-y-0.5 p-0">
        {shown.map((t) => (
          <li
            key={t.id}
            data-testid="debug-chat-eta-row"
            data-id={t.id}
            data-state={t.done ? "done" : t.at <= now ? "reached" : "running"}
            className="flex min-w-0 items-center gap-1.5"
          >
            <span className="min-w-0 max-w-[45%] truncate">{t.title}</span>
            <Meter
              frac={taskFraction(t, now)}
              color={t.done ? FILL_DONE : t.at <= now ? FILL_PAST : FILL}
            />
            <span className="shrink-0 tabular-nums opacity-70">
              {taskState(t, now, strings, lang)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
