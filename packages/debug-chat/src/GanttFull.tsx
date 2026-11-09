"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type EtaTask, compactTime, ganttPlan, isLate, splitTitle } from "./eta";
import {
  type Axis,
  axisTicks,
  axisToNow,
  axisWidth,
  extendAxis,
  ganttBar,
  ganttColor as c,
  ganttRows,
  initialAxis,
  pinchOf,
  rowsRange,
  wheelFactor,
  xOf,
  zoomAxis,
} from "./gantt-view";
import type { ChatStrings } from "./wire";

/**
 * The full-screen Gantt (owner, 2026-11-09 13:37–13:38 JST;
 * docs/dev-debug-widget.md, "Full-screen Gantt"): opened from the ETA bar, it
 * fills the viewport. One scroller: vertically through the tasks, the time
 * axis header sticky at the top; horizontally through time with no hard
 * limit (gantt-view.ts extendAxis), each task's name pinned at the left edge
 * of what is visible. A row's bar is its see-through background. The red Now
 * line runs down every row; on open it is a quarter from the left, and the
 * Now button brings it back. Pinch (touch) or ctrl+wheel (trackpad) zooms
 * about the fingers, minutes to days per screen. ✕ or Escape closes.
 */

const AXIS_H = 26;
const ROW_H = 30;
const ROW_GAP = 2;

type Strings = Pick<ChatStrings, "etaList" | "etaDone" | "etaGanttClose">;

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
  const rows = useMemo(() => ganttRows(ganttPlan(tasks, now)), [tasks, now]);
  const scroller = useRef<HTMLDivElement | null>(null);
  /** The view as the handlers last left it (several events may come before a render). */
  const view = useRef<{ axis: Axis; scrollLeft: number; w: number } | null>(null);
  /** A scrollLeft to apply once the content has its new width. */
  const pending = useRef<number | null>(null);
  const [axis, setAxis] = useState<Axis | null>(null);
  const [scrollX, setScrollX] = useState(0);
  const [w, setW] = useState(0);

  const commit = useCallback((next: { axis: Axis; scrollLeft: number }) => {
    const v = view.current;
    if (!v) return;
    view.current = { ...v, ...next };
    pending.current = next.scrollLeft;
    setAxis(next.axis);
    setScrollX(next.scrollLeft);
  }, []);

  // Open: measure, and put now a quarter from the left.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const nowRef = useRef(now);
  nowRef.current = now;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const width = el.clientWidth;
    const { from, to } = rowsRange(rowsRef.current, nowRef.current);
    const first = initialAxis(from, to, nowRef.current, width);
    view.current = { ...first, w: width };
    pending.current = first.scrollLeft;
    setW(width);
    setAxis(first.axis);
    setScrollX(first.scrollLeft);
    const ro = new ResizeObserver(() => {
      const v = view.current;
      if (!v || el.clientWidth === v.w) return;
      view.current = { ...v, w: el.clientWidth };
      setW(el.clientWidth);
      commit(extendAxis(v.axis, el.scrollLeft, el.clientWidth));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [commit]);

  // The content has its width: scroll to where the view should be.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !axis || pending.current === null) return;
    el.scrollLeft = pending.current;
    pending.current = null;
  }, [axis]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    const v = view.current;
    if (!el || !v || pending.current !== null) return;
    v.scrollLeft = el.scrollLeft;
    setScrollX(el.scrollLeft);
    const next = extendAxis(v.axis, el.scrollLeft, v.w);
    if (next.axis !== v.axis) commit(next);
  }, [commit]);

  const zoom = useCallback(
    (clientX: number, factor: number) => {
      const el = scroller.current;
      const v = view.current;
      if (!el || !v) return;
      const anchor = clientX - el.getBoundingClientRect().left;
      const from = pending.current ?? el.scrollLeft;
      const next = zoomAxis(v.axis, from, v.w, anchor, factor);
      if (next.axis !== v.axis) commit(next);
    },
    [commit],
  );

  // Pinch zooms the time scale, never the page (only here); ctrl+wheel is a trackpad's pinch.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let last: { dist: number } | null = null;
    let gesture = 1;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom(e.clientX, wheelFactor(e.deltaY));
    };
    const start = (e: TouchEvent) => {
      last = e.touches.length === 2 ? pinchOf(e.touches) : null;
    };
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const p = pinchOf(e.touches);
      if (last && last.dist > 0 && p.dist > 0) zoom(p.cx, p.dist / last.dist);
      last = p;
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) last = null;
    };
    // Safari's own trackpad pinch.
    const gStart = (e: Event) => {
      e.preventDefault();
      gesture = 1;
    };
    const gChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number };
      if (g.scale > 0) zoom(g.clientX, g.scale / gesture);
      gesture = g.scale;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("touchstart", start, { passive: true });
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

  const toNow = () => {
    const v = view.current;
    if (v) commit(axisToNow(v.axis, v.w, Date.now()));
  };

  const width = axis ? axisWidth(axis) : 0;
  const ticks = axis ? axisTicks(axis, scrollX, w, now) : [];
  const nowX = axis ? xOf(axis, now) : 0;
  const bodyH = rows.length * (ROW_H + ROW_GAP);

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
      <header
        className="flex shrink-0 items-center gap-2 px-3 py-1.5"
        style={{ borderBottom: `1px solid ${c("grid")}` }}
      >
        <h2 className="m-0 min-w-0 flex-1 truncate fs-12 font-semibold">{strings.etaList}</h2>
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
          <ul className="relative m-0 list-none p-0" style={{ paddingTop: ROW_GAP }}>
            {axis &&
              rows.map((t) => {
                const b = ganttBar(t, axis, now);
                const late = !t.done && t.at <= now;
                const state = t.done ? "done" : t.queued ? "queued" : late ? "reached" : "running";
                const { name, desc } = splitTitle(t.title);
                const left = t.at - now;
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
                      className="absolute inset-y-0 overflow-hidden rounded-sm"
                      style={{
                        left: b.x,
                        width: Math.max(3, b.w),
                        background: c(t.done ? "done" : t.queued ? "queued" : "bar"),
                        ...(t.queued ? { outline: `1px dashed ${c("muted")}`, outlineOffset: -1 } : {}),
                      }}
                    >
                      {!t.done && b.fill > 0 && (
                        <span
                          className="absolute inset-y-0 left-0"
                          style={{ width: b.fill, background: c("fill") }}
                        />
                      )}
                    </span>
                    {b.over > 0 && (
                      <span
                        aria-hidden
                        data-testid="debug-chat-gantt-over"
                        className="absolute inset-y-0 rounded-e-sm"
                        style={{ left: b.x + b.w, width: b.over, background: c(t.done ? "done" : "past") }}
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
                        <span className="font-semibold">{name}</span>
                        {desc && <span style={{ color: c("muted") }}> {desc}</span>}
                      </span>
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
