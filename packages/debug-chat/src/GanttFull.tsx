"use client";

import { useUi } from "@lianki/ui-state";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type EtaTask, compactTime, ganttPlan, isLate, isParked, parkMark, splitTitle } from "./eta";
import {
  CHAR_PX,
  type GanttAxis,
  type GanttScale,
  ganttBar,
  ganttColor as c,
  GANTT_END_SPACE,
  centreRowTop,
  fitSpan,
  focusRow,
  ganttRowsByEnd,
  LIVE_ATTR,
  LIVE_CSS,
  homeView,
  paceColor,
  paceOf,
  parkedBar,
  pinchOf,
  pinchStart,
  pinchView,
  rowsRange,
  scaleExtend,
  scaleTicks,
  scaleWidth,
  scaleX,
  scaleZoom,
  wheelFactor,
} from "./gantt-view";
import { ganttPrefs } from "./ui-store";
import type { ChatStrings } from "./wire";

/**
 * The full-screen Gantt (owner, 2026-11-09 13:37–13:38 JST;
 * docs/dev-debug-widget.md, "Full-screen Gantt"): opened from the ETA bar, it
 * fills the viewport. One scroller: vertically through the tasks, the time
 * axis header sticky at the top; horizontally through time with no hard
 * limit (gantt-view.ts extendAxis), each task's name pinned at the left edge
 * of what is visible. A row's bar is its see-through background. The red Now
 * line runs down every row. On open (owner, 2026-11-10) Now is at the
 * horizontal centre, the rows are sorted by end time (expected or actual),
 * the open task closest to ending is at the vertical centre, and the time
 * axis is zoomed so the 95th-percentile duration of it and its neighbours
 * fills the width (gantt-view.ts homeView, fitSpan); the Now button goes
 * back there. Blank space at the head and tail of the rows (GANTT_END_SPACE)
 * leaves the scroller room to bounce. Pinch (touch) or ctrl+wheel
 * (trackpad) zooms about the fingers' midpoint, batched to one step a frame;
 * on iPhone the touch pinch alone zooms (Safari's gesture events, which
 * fire alongside it, only stop the page zoom). ✕ or Escape closes.
 *
 * The axis is logarithmic by default (owner, 2026-11-09 15:27 JST): distance
 * from Now compressed symmetrically (gantt-view.ts symlog), so minute and day
 * tasks share a screen; the Linear | Log toggle switches, remembered per
 * device (ui-store.ts ganttPrefs, lk:pref:gantt).
 */

const AXIS_H = 26;
const ROW_H = 30;
const ROW_GAP = 2;
/** The progress underline's thickness, and the room left for it under the bar (px). */
const UNDERLINE_H = 3;
const UNDERLINE_GAP = 4;

type Strings = Pick<
  ChatStrings,
  | "etaList"
  | "etaDone"
  | "etaGanttClose"
  | "etaGanttScale"
  | "etaGanttLinear"
  | "etaGanttLog"
  | "etaWaitingYou"
  | "etaReminder"
  | "etaGanttLegend"
>;

/** A label character's width at the axis's text size (the tick spacing reads it). */
const charPxOf = (el: HTMLElement) => {
  const fs = Number.parseFloat(getComputedStyle(el).fontSize);
  return Number.isFinite(fs) && fs > 0 ? (fs * 2) / 3 : CHAR_PX;
};

export function GanttFull({
  tasks,
  now,
  strings,
  onClose,
}: {
  tasks: readonly EtaTask[];
  now: number;
  strings: Strings;
  onClose: () => void;
}) {
  const rows = useMemo(() => ganttRowsByEnd(ganttPlan(tasks, now)), [tasks, now]);
  const scale = useUi(ganttPrefs(), (s) => s.scale);
  /** This device's zoom overrides (ui-store.ts ganttPrefs), else the defaults. */
  const fitP = useUi(ganttPrefs(), (s) => s.fitPercentile);
  const fitW = useUi(ganttPrefs(), (s) => s.fitWidth);
  const fitRef = useRef({ p: fitP, w: fitW });
  fitRef.current = { p: fitP, w: fitW };
  const scroller = useRef<HTMLDivElement | null>(null);
  /** The view as the handlers last left it (several events may come before a render). */
  const view = useRef<{ axis: GanttAxis; scrollLeft: number; w: number } | null>(null);
  /** A scrollLeft to apply once the content has its new width. */
  const pending = useRef<number | null>(null);
  /** A scrollTop to apply with it (open: the focus row centred). */
  const pendingTop = useRef<number | null>(null);
  /** The view's height: the blank space at the head and tail of the rows is a share of it. */
  const [viewH, setViewH] = useState(0);
  const [axis, setAxis] = useState<GanttAxis | null>(null);
  const [scrollX, setScrollX] = useState(0);
  const [w, setW] = useState(0);
  const [charPx, setCharPx] = useState(CHAR_PX);

  const commit = useCallback((next: { axis: GanttAxis; scrollLeft: number }) => {
    const v = view.current;
    if (!v) return;
    view.current = { ...v, ...next };
    setScrollX(next.scrollLeft);
    const el = scroller.current;
    if (next.axis === v.axis && el) {
      // The same axis (the log one going back to Now): the content keeps its width, scroll now.
      el.scrollLeft = next.scrollLeft;
      return;
    }
    pending.current = next.scrollLeft;
    setAxis(next.axis);
  }, []);

  // Open (and on a switch of axis): measure, and go to the home view.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const nowRef = useRef(now);
  nowRef.current = now;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  /** Now centred, the focus row centred, zoomed to fit (gantt-view.ts homeView). */
  const home = useCallback((el: HTMLDivElement) => {
    const width = el.clientWidth;
    const rs = rowsRef.current;
    const t = nowRef.current;
    const focus = focusRow(rs, t);
    const { p, w: share } = fitRef.current;
    const first = homeView(
      scaleRef.current,
      fitSpan(rs, focus, p),
      t,
      width,
      rowsRange(rs, t),
      share,
    );
    pendingTop.current = centreRowTop({
      i: focus,
      viewH: el.clientHeight,
      axisH: AXIS_H,
      headSpace: Math.round(GANTT_END_SPACE * el.clientHeight),
      rowH: ROW_H,
      rowGap: ROW_GAP,
    });
    return first;
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const width = el.clientWidth;
    const first = home(el);
    view.current = { ...first, w: width };
    pending.current = first.scrollLeft;
    setW(width);
    setViewH(el.clientHeight);
    setCharPx(charPxOf(el));
    setAxis(first.axis);
    setScrollX(first.scrollLeft);
    const ro = new ResizeObserver(() => {
      setViewH(el.clientHeight);
      const v = view.current;
      if (!v || el.clientWidth === v.w) return;
      view.current = { ...v, w: el.clientWidth };
      setW(el.clientWidth);
      commit(scaleExtend(v.axis, el.scrollLeft, el.clientWidth));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [commit, scale, home]);

  // The content has its width: scroll to where the view should be.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !axis || pending.current === null) return;
    el.scrollLeft = pending.current;
    pending.current = null;
    if (pendingTop.current !== null) {
      el.scrollTop = pendingTop.current;
      pendingTop.current = null;
    }
  }, [axis, viewH]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    const v = view.current;
    if (!el || !v || pending.current !== null) return;
    v.scrollLeft = el.scrollLeft;
    setScrollX(el.scrollLeft);
    const next = scaleExtend(v.axis, el.scrollLeft, v.w);
    if (next.axis !== v.axis) commit(next);
  }, [commit]);

  /**
   * Zoom by `factor` about clientX, then pan by dx (a pinch's midpoint
   * moving): the time under the fingers stays under them.
   */
  const zoom = useCallback(
    (clientX: number, factor: number, dx = 0) => {
      const el = scroller.current;
      const v = view.current;
      if (!el || !v) return;
      const anchor = clientX - el.getBoundingClientRect().left;
      const from = pending.current ?? el.scrollLeft;
      const next = scaleZoom(v.axis, from, v.w, anchor, factor, nowRef.current);
      if (next.axis !== v.axis || dx) commit({ ...next, scrollLeft: next.scrollLeft + dx });
    },
    [commit],
  );

  // Pinch zooms the time scale, never the page (only here); ctrl+wheel is a trackpad's pinch.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    /** The pinch under way: its start (t0 under the midpoint) and where the fingers are now. */
    let pinch: {
      from: ReturnType<typeof pinchStart>;
      dist0: number;
      cy0: number;
      top0: number;
      now: ReturnType<typeof pinchOf>;
    } | null = null;
    let gesture = 1;
    /** Two fingers are down: iOS's gesture events then only stop the page zoom (no second zoom). */
    let touching = false;
    // One zoom step a frame: the steps between frames multiply, the pans add.
    let step: { cx: number; factor: number; dx: number; dy: number } | null = null;
    let frame = 0;
    /** A client x as px from the view's left edge (the scroller's own box). */
    const viewX = (clientX: number) => clientX - el.getBoundingClientRect().left - el.clientLeft;
    const flush = () => {
      frame = 0;
      if (pinch) {
        // Absolute from the pinch's start: t0 back under the midpoint, exactly.
        const p = pinch.now;
        const v = view.current;
        if (v && pinch.dist0 > 0 && p.dist > 0)
          commit(pinchView(pinch.from, p.dist / pinch.dist0, viewX(p.cx), v.w, nowRef.current));
        el.scrollTop = pinch.top0 + (pinch.cy0 - p.cy);
        return;
      }
      const s = step;
      step = null;
      if (!s) return;
      zoom(s.cx, s.factor, s.dx);
      if (s.dy) el.scrollTop += s.dy;
    };
    const queue = (cx: number, factor: number, dx = 0, dy = 0) => {
      step = step
        ? { cx, factor: step.factor * factor, dx: step.dx + dx, dy: step.dy + dy }
        : { cx, factor, dx, dy };
      frame ||= requestAnimationFrame(flush);
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      queue(e.clientX, wheelFactor(e.deltaY));
    };
    const begin = (touches: TouchList) => {
      const v = view.current;
      if (!v) return;
      const p = pinchOf(touches);
      const left = pending.current ?? el.scrollLeft;
      pinch = {
        from: pinchStart(v.axis, left, viewX(p.cx), nowRef.current),
        dist0: p.dist,
        cy0: p.cy,
        top0: el.scrollTop,
        now: p,
      };
    };
    const start = (e: TouchEvent) => {
      touching = e.touches.length >= 2;
      if (e.touches.length === 2) begin(e.touches);
      else pinch = null;
      // Two fingers: no native pan or page zoom from here on.
      if (touching) e.preventDefault();
    };
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      if (!pinch) begin(e.touches);
      if (!pinch) return;
      pinch.now = pinchOf(e.touches);
      frame ||= requestAnimationFrame(flush);
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        // The last move still waiting for its frame lands first, then the pinch ends.
        if (frame && pinch) {
          cancelAnimationFrame(frame);
          flush();
        }
        pinch = null;
        touching = false;
      }
    };
    // Safari's own pinch: a Mac trackpad's zoom; on iPhone it fires with the
    // touches above, so it only keeps the page from zooming.
    const gStart = (e: Event) => {
      e.preventDefault();
      gesture = 1;
    };
    const gChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number };
      if (!touching && g.scale > 0) queue(g.clientX, g.scale / gesture);
      gesture = g.scale;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    el.addEventListener("gesturestart", gStart);
    el.addEventListener("gesturechange", gChange);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("gesturestart", gStart);
      el.removeEventListener("gesturechange", gChange);
      cancelAnimationFrame(frame);
    };
  }, [zoom]);

  // Escape closes this view only (the chat behind it stays as it is).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  const closeBtn = useRef<HTMLButtonElement | null>(null);
  useEffect(() => closeBtn.current?.focus({ preventScroll: true }), []);

  // Now: back to the home view (Now centred, the focus row centred, the fitted zoom).
  const toNow = () => {
    const el = scroller.current;
    if (!el || !view.current) return;
    nowRef.current = Date.now();
    commit(home(el));
    // The same axis scrolled at once in commit; a new one sets the top in the layout effect.
    if (pending.current === null && pendingTop.current !== null) {
      el.scrollTop = pendingTop.current;
      pendingTop.current = null;
    }
  };
  const setScale = (s: GanttScale) => ganttPrefs().setState({ scale: s });

  const width = axis ? scaleWidth(axis) : 0;
  const ticks = axis ? scaleTicks(axis, scrollX, w, now, charPx) : [];
  const nowX = axis ? scaleX(axis, now, now) : 0;
  /** Blank space at the head and the tail of the rows (GANTT_END_SPACE of the view). */
  const endSpace = Math.round(GANTT_END_SPACE * viewH);
  const bodyH = rows.length * (ROW_H + ROW_GAP) + 2 * endSpace;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={strings.etaList}
      data-testid="debug-chat-gantt"
      className="fixed inset-0 flex flex-col fs-12"
      style={{
        zIndex: "var(--lk-z-chat-modal, 90)",
        background: c("track"),
        color: c("text"),
        colorScheme: "light dark",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <style>{LIVE_CSS}</style>
      <header
        className="flex shrink-0 items-center gap-2 px-3 py-1.5"
        style={{ borderBottom: `1px solid ${c("grid")}` }}
      >
        <h2 className="m-0 min-w-0 flex-1 truncate fs-12 font-semibold">{strings.etaList}</h2>
        {/* The time axis: logarithmic (default) or linear; this device remembers. */}
        <div
          role="group"
          aria-label={strings.etaGanttScale}
          data-testid="debug-chat-gantt-scale"
          data-scale={scale}
          className="flex shrink-0 overflow-hidden rounded"
          style={{ border: `1px solid ${c("grid")}` }}
        >
          {(
            [
              ["linear", strings.etaGanttLinear],
              ["log", strings.etaGanttLog],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              data-testid={`debug-chat-gantt-scale-${k}`}
              aria-pressed={scale === k}
              onClick={() => setScale(k)}
              className="tap-40 px-2 py-1"
              style={{
                border: 0,
                color: c("text"),
                fontWeight: scale === k ? 600 : 400,
                background: scale === k ? c("bar") : "transparent",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="debug-chat-gantt-now-btn"
          onClick={toNow}
          className="tap-40 rounded px-2 py-1 font-semibold"
          style={{ color: c("late"), border: `1px solid ${c("late")}`, background: "transparent" }}
        >
          Now
        </button>
        <button
          ref={closeBtn}
          type="button"
          data-testid="debug-chat-gantt-close"
          aria-label={strings.etaGanttClose}
          title={strings.etaGanttClose}
          onClick={onClose}
          className="tap-40 rounded px-2 py-1"
          style={{ color: c("text"), background: "transparent", border: 0 }}
        >
          ✕
        </button>
      </header>
      {/* What the marks mean: the underline is the reported progress, the red line now. */}
      <p
        data-testid="debug-chat-gantt-legend"
        className="m-0 shrink-0 truncate px-3 py-0.5 fs-10"
        style={{ color: c("muted"), borderBottom: `1px solid ${c("grid")}` }}
      >
        {strings.etaGanttLegend}
      </p>
      <div
        ref={scroller}
        data-testid="debug-chat-gantt-scroll"
        dir="ltr"
        onScroll={onScroll}
        className="min-h-0 flex-1"
        style={{ overflow: "auto", overscrollBehavior: "contain", touchAction: "pan-x pan-y" }}
      >
        <div
          data-testid="debug-chat-gantt-content"
          data-scale={scale}
          style={{ position: "relative", width: Math.max(width, w), minHeight: AXIS_H + bodyH }}
        >
          {/* The axis: sticky at the top while the rows scroll under it. */}
          <div
            data-testid="debug-chat-gantt-axis"
            aria-hidden
            style={{
              position: "sticky",
              top: 0,
              zIndex: 3,
              height: AXIS_H,
              background: c("track"),
              borderBottom: `1px solid ${c("grid")}`,
            }}
          >
            {ticks.map((t) => (
              <span
                key={t.t}
                data-testid={t.now ? "debug-chat-gantt-now-label" : "debug-chat-gantt-tick"}
                className="absolute top-0 whitespace-nowrap tabular-nums"
                style={{
                  left: t.x,
                  transform: "translateX(-50%)",
                  lineHeight: `${AXIS_H}px`,
                  color: t.now ? c("late") : c("muted"),
                  fontWeight: t.now ? 700 : 400,
                }}
              >
                {t.label}
              </span>
            ))}
            {/* Now, labelled even between ticks. */}
            {!ticks.some((t) => t.now) && axis && (
              <span
                data-testid="debug-chat-gantt-now-label"
                className="absolute top-0 font-bold"
                style={{
                  left: nowX,
                  transform: "translateX(-50%)",
                  lineHeight: `${AXIS_H}px`,
                  color: c("late"),
                }}
              >
                Now
              </span>
            )}
          </div>
          {/* The grid and the red Now line, under the see-through bars. */}
          <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: AXIS_H, bottom: 0 }}>
            {ticks.map((t) =>
              t.now ? null : (
                <span
                  key={t.t}
                  className="absolute inset-y-0"
                  style={{ left: t.x, width: 1, background: c("grid") }}
                />
              ),
            )}
            {axis && (
              <span
                data-testid="debug-chat-gantt-now"
                className="absolute inset-y-0"
                style={{ left: nowX - 1, width: 2, background: c("late") }}
              />
            )}
          </div>
          <ul
            data-testid="debug-chat-gantt-rows"
            className="relative m-0 list-none p-0"
            style={{ paddingTop: ROW_GAP + endSpace, paddingBottom: endSpace }}
          >
            {axis &&
              rows.map((t) => {
                const b = ganttBar(t, axis, now);
                const late = !t.done && t.at <= now;
                const parked = isParked(t);
                const mark = parkMark(t);
                const state = t.done
                  ? "done"
                  : parked
                    ? "parked"
                    : t.queued
                      ? "queued"
                      : late
                        ? "reached"
                        : "running";
                const { name, desc } = splitTitle(t.title);
                const left = t.at - now;
                // Parked: its time is when the reminder goes off, never work remaining.
                const reminder = strings.etaReminder.replace("{t}", compactTime(left));
                return (
                  <li
                    key={t.id}
                    data-testid="debug-chat-gantt-row"
                    data-id={t.id}
                    data-state={state}
                    className="relative flex items-center"
                    style={{ height: ROW_H, marginBottom: ROW_GAP }}
                  >
                    <span
                      aria-hidden
                      data-testid="debug-chat-gantt-bar"
                      className="absolute overflow-hidden rounded-sm"
                      style={{
                        top: 0,
                        bottom: UNDERLINE_GAP,
                        left: b.x,
                        width: Math.max(3, b.w),
                        background: c(t.done ? "done" : t.queued ? "queued" : "bar"),
                        ...(t.queued ? { outline: `1px dashed ${c("muted")}`, outlineOffset: -1 } : {}),
                        ...(parked ? parkedBar(c("bar"), c("muted")) : {}),
                      }}
                    />
                    {!parked && !t.queued && b.fill > 0 && (() => {
                      // The reported progress: an underline beneath the planned span,
                      // tinted by its end against Now; live (pulsing, an arrow) while it runs.
                      const live = !t.done;
                      const end = b.x + b.fill;
                      const pace = live ? paceOf(end, nowX) : "on";
                      const ink = paceColor(pace);
                      const liveAttr = live ? { [LIVE_ATTR]: true } : {};
                      return (
                        <>
                          <span
                            aria-hidden
                            data-testid="debug-chat-gantt-progress"
                            data-pace={pace}
                            data-gantt-line
                            {...liveAttr}
                            className="absolute rounded-full"
                            style={{
                              left: b.x,
                              width: Math.max(2, b.fill),
                              bottom: 0,
                              height: UNDERLINE_H,
                              background: ink,
                            }}
                          />
                          {live && (
                            <span
                              aria-hidden
                              data-testid="debug-chat-gantt-frontier"
                              {...liveAttr}
                              className="absolute leading-none"
                              style={{ left: end - 1, bottom: -2, fontSize: 8, color: ink }}
                            >
                              →
                            </span>
                          )}
                          <span
                            data-testid="debug-chat-gantt-pct"
                            className="absolute tabular-nums leading-none"
                            style={{
                              left: end + (live ? 9 : 2),
                              bottom: 0,
                              fontSize: 9,
                              color: c("muted"),
                            }}
                          >
                            {Math.round(t.done ? 100 : (t.pct ?? 0))}%
                          </span>
                        </>
                      );
                    })()}
                    {b.over > 0 && !parked && (
                      <span
                        aria-hidden
                        data-testid="debug-chat-gantt-over"
                        className="absolute rounded-e-sm"
                        style={{
                          top: 0,
                          bottom: UNDERLINE_GAP,
                          left: b.x + b.w,
                          width: b.over,
                          background: c(t.done ? "done" : "past"),
                        }}
                      />
                    )}
                    {/* The name: pinned at the left of what is visible, over the bar. */}
                    <span
                      data-testid="debug-chat-gantt-name"
                      title={t.title}
                      className="flex min-w-0 items-baseline gap-1.5 px-2"
                      style={{
                        position: "sticky",
                        left: 0,
                        zIndex: 1,
                        maxWidth: "min(36rem, calc(100vw - 1rem))",
                      }}
                    >
                      <span dir="auto" className="min-w-0 truncate">
                        {mark && (
                          // Waits for the owner: a red "!" ("?" for a decision) before the name.
                          <span
                            role="img"
                            aria-label={strings.etaWaitingYou}
                            title={strings.etaWaitingYou}
                            data-testid="debug-chat-gantt-mark"
                            className="me-1 font-bold"
                            style={{ color: c("late") }}
                          >
                            {mark}
                          </span>
                        )}
                        <span className="font-semibold">{name}</span>
                        {desc && <span style={{ color: c("muted") }}> {desc}</span>}
                      </span>
                      {parked ? (
                        <span
                          data-testid="debug-chat-gantt-time"
                          data-parked={t.parked}
                          className="shrink-0 tabular-nums"
                          style={{ color: c("muted") }}
                        >
                          {mark ? `${strings.etaWaitingYou} · ${reminder}` : reminder}
                        </span>
                      ) : (
                        <span
                          data-testid="debug-chat-gantt-time"
                          data-late={(!t.done && isLate(left)) || undefined}
                          className="shrink-0 tabular-nums"
                          style={
                            !t.done && isLate(left) ? { color: c("late"), fontWeight: 600 } : undefined
                          }
                        >
                          {t.done ? strings.etaDone : compactTime(left)}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
          </ul>
        </div>
      </div>
    </div>
  );
}
