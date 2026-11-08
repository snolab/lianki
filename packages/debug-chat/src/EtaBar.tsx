"use client";

import type { ReactNode } from "react";
import {
  type EtaTask,
  etaSummary,
  shortLeft,
  shownTasks,
  splitTitle,
  taskFraction,
} from "./eta";
import type { ChatStrings } from "./wire";

/**
 * The ETA bar (eta.ts): one line above the chat input summing up every timed
 * task — overall progress weighted by the estimates, time left, and with
 * several, their count and when the next is due. A tap opens the state tree,
 * where EtaList shows each task. Nothing when there is no timed task.
 */

/** A tap on the bar must not take focus from the input (the keyboard stays). */
export const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/**
 * No meter of its own (owner, 2026-11-08 19:32 JST): the line's own background
 * is the bar, filled from the start edge to the progress point. Every colour is
 * opaque and named here, in both themes, so the text's contrast is known on
 * the filled and the unfilled part alike: one text colour, WCAG AA (4.5:1) on
 * all four backgrounds of a theme (unit/eta.test.ts computes it).
 */
export const ETA_COLORS = {
  light: {
    text: "oklch(0.3 0.02 260)",
    muted: "oklch(0.45 0.02 260)",
    track: "oklch(0.96 0.006 260)",
    fill: "oklch(0.87 0.06 250)",
    past: "oklch(0.89 0.07 75)",
    done: "oklch(0.89 0.06 150)",
  },
  dark: {
    text: "oklch(0.93 0.01 260)",
    muted: "oklch(0.8 0.01 260)",
    track: "oklch(0.24 0.01 260)",
    fill: "oklch(0.38 0.08 250)",
    past: "oklch(0.4 0.07 65)",
    done: "oklch(0.38 0.07 150)",
  },
} as const;

type Tone = "fill" | "past" | "done";
const both = (k: keyof (typeof ETA_COLORS)["light"]) =>
  `light-dark(${ETA_COLORS.light[k]}, ${ETA_COLORS.dark[k]})`;

/** A list row's title: the name in bold, the description muted (both AA on every fill). */
function TitleParts({ title }: { title: string }) {
  const { name, desc } = splitTitle(title);
  return (
    <span title={title} className="min-w-0 flex-1 truncate">
      <span className="font-semibold">{name}</span>
      {desc && (
        <span data-testid="debug-chat-eta-desc" style={{ color: both("muted") }}>
          {" "}
          {desc}
        </span>
      )}
    </span>
  );
}

/** A task's (or the summary's) tone: done, past its estimate, or running. */
const toneOf = (done: boolean, past: boolean): Tone => (done ? "done" : past ? "past" : "fill");

/**
 * A line whose background is its progress: the track, and over it the fill
 * from the start edge (RTL too) to `frac`. The fill sits behind the text.
 */
function FillLine({
  frac,
  tone,
  className,
  children,
}: {
  frac: number;
  tone: Tone;
  className: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`relative isolate flex min-w-0 items-center gap-1.5 overflow-hidden rounded ${className}`}
      style={{ background: both("track"), color: both("text") }}
    >
      <span
        aria-hidden
        data-testid="debug-chat-eta-fill"
        data-tone={tone}
        className="absolute inset-y-0 start-0 -z-10 transition-[width] duration-700 motion-reduce:transition-none"
        style={{ width: `${Math.round(frac * 100)}%`, background: both(tone) }}
      />
      {children}
    </span>
  );
}

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

/** One task's state: done, past its estimate, or the time left. */
export function taskState(t: EtaTask, now: number, s: EtaText, lang?: string) {
  if (t.done) return s.etaDone;
  return t.at <= now ? s.etaReached : s.etaLeft.replace("{t}", shortLeft(t.at - now, lang));
}

/** The summary line's text: "Title · 25m left", or "3 tasks · 1h left · next in 5m". */
export function summaryText(tasks: readonly EtaTask[], now: number, s: EtaText, lang?: string) {
  const sum = etaSummary(tasks, now);
  if (!sum.count) return "";
  if (sum.only) return `${splitTitle(sum.only.title).name} · ${taskState(sum.only, now, s, lang)}`;
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
      className="pointer-events-auto mb-1 block w-full min-w-0 border-0 bg-transparent p-0 text-start fs-10"
    >
      <FillLine
        frac={sum.pct / 100}
        tone={toneOf(sum.leftMs === null, past)}
        className="w-full px-2 py-0.5"
      >
        <EtaClockIcon />
        <span data-testid="debug-chat-eta-text" className="min-w-0 flex-1 truncate">
          {text}
        </span>
        <span className="shrink-0 tabular-nums">{sum.pct}%</span>
      </FillLine>
    </button>
  );
}

/** The status area's list (top of the state tree panel): every timed task, its line filled to its progress, and its time left. */
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
            className="min-w-0"
          >
            <FillLine
              frac={taskFraction(t, now)}
              tone={toneOf(!!t.done, t.at <= now)}
              className="px-1.5 py-px"
            >
              <TitleParts title={t.title} />
              <span className="shrink-0 tabular-nums">{taskState(t, now, strings, lang)}</span>
            </FillLine>
          </li>
        ))}
      </ul>
    </section>
  );
}
