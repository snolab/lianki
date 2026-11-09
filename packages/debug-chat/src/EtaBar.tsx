"use client";

import type { ReactNode } from "react";
import {
  type EtaTask,
  compactTime,
  etaSummary,
  ganttPlan,
  ganttRow,
  ganttWindow,
  isLate,
  shownTasks,
  splitTitle,
} from "./eta";
import type { ChatStrings } from "./wire";

/**
 * The ETA bar (eta.ts): one line above the chat input summing up every timed
 * task — overall progress weighted by the estimates, time left, and with
 * several, their count and when the next is due. A tap opens the state tree,
 * where EtaList shows each task as a Gantt row. Nothing when there is no
 * timed task. Every time label is compactTime ("5M", "1.5H", "-5M"); a
 * negative one is red.
 */

/** A tap on the bar must not take focus from the input (the keyboard stays). */
export const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/**
 * No meter of its own (owner, 2026-11-08 19:32 JST): the line's own background
 * is the bar. Every colour is opaque and named here, in both themes, so the
 * text's contrast is known on every part: `text`, `muted` (a row's
 * description) and `late` (a negative time, red) are each WCAG AA (4.5:1) on
 * the track, the planned bar, the progress fill, the overrun and done
 * (unit/eta.test.ts computes it).
 */
export const ETA_COLORS = {
  light: {
    text: "oklch(0.3 0.02 260)",
    muted: "oklch(0.45 0.02 260)",
    late: "oklch(0.47 0.17 27)",
    track: "oklch(0.96 0.006 260)",
    bar: "oklch(0.905 0.04 250)",
    fill: "oklch(0.86 0.07 250)",
    past: "oklch(0.9 0.05 25)",
    done: "oklch(0.89 0.06 150)",
  },
  dark: {
    text: "oklch(0.93 0.01 260)",
    muted: "oklch(0.8 0.01 260)",
    late: "oklch(0.8 0.12 25)",
    track: "oklch(0.24 0.01 260)",
    bar: "oklch(0.3 0.04 250)",
    fill: "oklch(0.38 0.08 250)",
    past: "oklch(0.36 0.08 25)",
    done: "oklch(0.38 0.07 150)",
  },
} as const;

type Tone = "fill" | "past" | "done";
export const etaColor = (k: keyof (typeof ETA_COLORS)["light"]) =>
  `light-dark(${ETA_COLORS.light[k]}, ${ETA_COLORS.dark[k]})`;
const both = etaColor;

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

/** A time label (compactTime): red when negative (past due). */
function TimeLabel({ ms }: { ms: number }) {
  const late = isLate(ms);
  return (
    <span
      data-testid="debug-chat-eta-time"
      data-late={late || undefined}
      className="shrink-0 tabular-nums"
      style={late ? { color: both("late"), fontWeight: 600 } : undefined}
    >
      {compactTime(ms)}
    </span>
  );
}

/** A task's (or the summary's) tone: done, past its estimate, or running. */
const toneOf = (done: boolean, past: boolean): Tone => (done ? "done" : past ? "past" : "fill");

/**
 * Activity on a running bar (owner, 2026-11-10): a soft light sweeps along
 * the fill, so a task in progress never looks frozen. Its own keyframes
 * (the hot-loaded widget has no app stylesheet); none under reduced motion.
 */
export const ETA_SHIMMER_CSS =
  "@keyframes lk-eta-sweep{from{transform:translateX(-100%)}to{transform:translateX(100%)}}" +
  "@media (prefers-reduced-motion: reduce){[data-eta-shimmer]{display:none}}";
const SHIMMER_BG =
  "linear-gradient(90deg, transparent, light-dark(oklch(1 0 0 / 0.55), oklch(1 0 0 / 0.16)), transparent)";

/**
 * A line whose background is its progress: the track, and over it the fill
 * from the start edge (RTL too) to `frac`. The fill sits behind the text.
 * `glass`: no track of its own (the chat's glass strip is behind it).
 * `busy`: the fill shimmers (ETA_SHIMMER_CSS).
 */
function FillLine({
  frac,
  tone,
  className,
  glass = false,
  busy = false,
  children,
}: {
  frac: number;
  tone: Tone;
  className: string;
  glass?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      // In the glass strip a full pill (end caps half its height), concentric with the strip's corners.
      className={`relative isolate flex min-w-0 items-center gap-1.5 overflow-hidden ${glass ? "rounded-full" : "rounded"} ${className}`}
      style={{ background: glass ? "transparent" : both("track"), color: both("text") }}
    >
      <span
        aria-hidden
        data-testid="debug-chat-eta-fill"
        data-tone={tone}
        className="absolute inset-y-0 start-0 -z-10 overflow-hidden transition-[width] duration-700 motion-reduce:transition-none"
        style={{ width: `${Math.round(frac * 100)}%`, background: both(tone) }}
      >
        {busy && (
          <>
            <style>{ETA_SHIMMER_CSS}</style>
            <span
              data-eta-shimmer
              data-testid="debug-chat-eta-shimmer"
              className="absolute inset-0"
              style={{ background: SHIMMER_BG, animation: "lk-eta-sweep 1.8s linear infinite" }}
            />
          </>
        )}
      </span>
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

/** One task's state: done, or its time left (compactTime, negative past due). */
export function taskState(t: EtaTask, now: number, s: EtaText) {
  return t.done ? s.etaDone : compactTime(t.at - now);
}

/**
 * The summary line's parts: what it is about ("Title", "3 tasks"), the time
 * left (null when all are done: `doneText`), and with several, the next due.
 */
function summaryParts(tasks: readonly EtaTask[], now: number, s: EtaText) {
  const sum = etaSummary(tasks, now);
  if (!sum.count) return null;
  const lead = sum.only
    ? splitTitle(sum.only.title).name
    : s.etaTasks.replace("{n}", String(sum.count));
  const leftMs = sum.only ? (sum.only.done ? null : sum.only.at - now) : sum.leftMs;
  const next =
    !sum.only && sum.next && sum.open > 1 && sum.next.at < now + (sum.leftMs ?? 0)
      ? s.etaNext.replace("{t}", compactTime(sum.next.at - now))
      : null;
  return { sum, lead, leftMs, next };
}

/** The summary line's text: "Title · 25M", or "3 tasks · 1.5H · next in 5M". */
export function summaryText(tasks: readonly EtaTask[], now: number, s: EtaText) {
  const p = summaryParts(tasks, now, s);
  if (!p) return "";
  return [p.lead, p.leftMs === null ? s.etaDone : compactTime(p.leftMs), p.next]
    .filter(Boolean)
    .join(" · ");
}

export function EtaBar({
  tasks,
  now,
  strings,
  onOpen,
  glass = false,
}: {
  tasks: readonly EtaTask[];
  now: number;
  strings: EtaText;
  onOpen: () => void;
  /** Part of the chat's glass strip (DebugChat): no track, no gap under it. */
  glass?: boolean;
}) {
  const p = summaryParts(tasks, now, strings);
  if (!p) return null;
  const { sum } = p;
  const past = sum.leftMs !== null && sum.leftMs <= 0;
  const text = summaryText(tasks, now, strings);
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
      className={`pointer-events-auto block w-full min-w-0 border-0 bg-transparent p-0 text-start fs-10 ${glass ? "" : "mb-1"}`}
    >
      <FillLine
        frac={sum.pct / 100}
        tone={toneOf(sum.leftMs === null, past)}
        className="w-full px-2 py-0.5"
        glass={glass}
        // In progress: something still open (not all done).
        busy={p.leftMs !== null && sum.open > 0}
      >
        <EtaClockIcon />
        <span data-testid="debug-chat-eta-text" className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="min-w-0 truncate">{p.lead}</span>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          {p.leftMs === null ? (
            <span className="shrink-0">{strings.etaDone}</span>
          ) : (
            <TimeLabel ms={p.leftMs} />
          )}
          {p.next && <span className="min-w-0 truncate">· {p.next}</span>}
        </span>
        <span className="shrink-0 tabular-nums">{sum.pct}%</span>
      </FillLine>
    </button>
  );
}

/**
 * The status area's list (top of the state tree panel) as a Gantt chart
 * (owner, 2026-11-08 20:24 JST): every row shares one time axis
 * (ganttWindow), and a row's own background is its bar — from when the work
 * started to its estimate, the progress (pct) a deeper fill inside it, and
 * past the estimate a red overrun on to now. Queued tasks (status waiting)
 * run one after another (ganttPlan). A vertical line marks now, labelled
 * "Now" under the rows (language-neutral, owner 2026-11-09 01:38 JST); it
 * moves with the page's one ETA clock (eta.ts etaClock). No
 * estimate, start, end or actual numbers are drawn (those stay agent-only);
 * a row shows its title and its time left, red once negative.
 */
export function EtaList({
  tasks,
  now,
  strings,
  onExpand,
}: {
  tasks: readonly EtaTask[];
  now: number;
  strings: EtaText;
  /** Open the full-screen Gantt (GanttFull.tsx). */
  onExpand?: () => void;
}) {
  const shown = ganttPlan(shownTasks(tasks, now), now);
  const win = ganttWindow(shown, now);
  if (!shown.length || !win) return null;
  const nowAt = ganttRow(shown[0]!, win, now).now;
  return (
    <section data-testid="debug-chat-eta-list" className="mb-1.5 min-w-0 fs-10">
      <h3 className="m-0 mb-0.5 flex items-center gap-1 fs-10 font-semibold opacity-70">
        <EtaClockIcon size={11} />
        <span className="min-w-0 flex-1 truncate">{strings.etaList}</span>
        {onExpand && (
          <button
            type="button"
            data-testid="debug-chat-eta-expand"
            aria-label={strings.etaOpen}
            title={strings.etaOpen}
            onMouseDown={keepFocus}
            onClick={onExpand}
            className="tap-40 shrink-0 border-0 bg-transparent px-1 py-0 fs-12 leading-none"
            style={{ color: both("text") }}
          >
            ⤢
          </button>
        )}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-px p-0">
        {shown.map((t) => {
          const g = ganttRow(t, win, now);
          const reached = !t.done && t.at <= now;
          const state = t.done ? "done" : reached ? "reached" : "running";
          return (
            <li
              key={t.id}
              data-testid="debug-chat-eta-row"
              data-id={t.id}
              data-state={state}
              className="relative isolate flex min-w-0 items-center gap-1.5 overflow-hidden rounded px-1.5 py-px"
              style={{ background: both("track"), color: both("text") }}
            >
              <span
                aria-hidden
                data-testid="debug-chat-eta-span"
                data-tone={toneOf(!!t.done, false)}
                className="absolute inset-y-0 -z-10 overflow-hidden transition-[width,inset-inline-start] duration-700 motion-reduce:transition-none"
                style={{
                  insetInlineStart: `${g.left}%`,
                  width: `${g.plan}%`,
                  minWidth: 3,
                  background: both(t.done ? "done" : "bar"),
                }}
              >
                {!t.done && g.fill > 0 && (
                  <span
                    data-testid="debug-chat-eta-fill"
                    className="absolute inset-y-0 start-0"
                    style={{ width: `${g.fill}%`, background: both("fill") }}
                  />
                )}
              </span>
              {g.over > 0 && (
                <span
                  aria-hidden
                  data-testid="debug-chat-eta-over"
                  className="absolute inset-y-0 -z-10"
                  style={{
                    insetInlineStart: `${g.left + g.plan}%`,
                    width: `${g.over}%`,
                    background: both(t.done ? "done" : "past"),
                  }}
                />
              )}
              <span
                aria-hidden
                data-testid="debug-chat-eta-now"
                className="absolute inset-y-0 -z-10 w-0.5 -translate-x-1/2 rtl:translate-x-1/2"
                style={{ insetInlineStart: `${g.now}%`, background: both("late") }}
              />
              <TitleParts title={t.title} />
              {t.done ? (
                <span className="shrink-0">{strings.etaDone}</span>
              ) : (
                <TimeLabel ms={t.at - now} />
              )}
            </li>
          );
        })}
      </ul>
      {/* The axis: a red "Now" under the red line (on the track, so its contrast is known). */}
      <div
        aria-hidden
        data-testid="debug-chat-eta-axis"
        className="relative h-3.5 overflow-hidden rounded-b"
        style={{ background: both("track"), color: both("text") }}
      >
        <span
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 rtl:translate-x-1/2"
          style={{ insetInlineStart: `${nowAt}%`, background: both("late") }}
        />
        <span
          data-testid="debug-chat-eta-now-label"
          className="absolute top-0 px-1 font-semibold leading-[0.875rem]"
          style={{
            color: both("late"),
            ...(nowAt > 85 ? { insetInlineEnd: `${100 - nowAt}%` } : { insetInlineStart: `${nowAt}%` }),
          }}
        >
          Now
        </span>
      </div>
    </section>
  );
}
