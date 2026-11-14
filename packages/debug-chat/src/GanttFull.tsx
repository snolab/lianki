"use client";

import { useUi } from "@lianki/ui-state";
import { Disclosure } from "./icons";
import {
  type CSSProperties,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type EtaTask,
  compactTime,
  etaLabel,
  ganttPlan,
  isLate,
  isParked,
  parkMark,
  splitTitle,
} from "./eta";
import {
  CHAR_PX,
  type GanttAxis,
  type GanttScale,
  axisLabel,
  ganttBar,
  ganttColor as c,
  ganttSpan,
  ganttTickX,
  ghostShows,
  type OffSide,
  offScreenSide,
  revealScrollLeft,
  TAIL_ATTR,
  TAIL_CSS,
  TAIL_VAR,
  tickGroup,
  tickGroupText,
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
import {
  DBLTAP,
  DBLTAP_IDLE,
  type DbltapPointer,
  type DbltapState,
  type DbltapStep,
  dbltapCancel,
  dbltapDown,
  dbltapHolds,
  dbltapMove,
  dbltapUp,
} from "./gantt-dbltap";
import {
  GANTT_GROUPS,
  type GanttGroupDef,
  type GanttLine,
  ganttLines,
  groupName,
  groupRowH,
  laneBox,
  lineOf,
  toggleOpen,
} from "./gantt-groups";
import { ganttGroupsUi, ganttPrefs } from "./ui-store";
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
 * fire alongside it, only stop the page zoom). Touch or pen only, a tap
 * and then a drag zooms like a map (gantt-dbltap.ts): down = in, the time
 * under the finger stays under it. ✕ or Escape closes.
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
  | "etaGanttLegendTicks"
  | "etaTickEarlier"
  | "etaTickLater"
  | "etaTickConfirmed"
  | "etaTickSet"
  | "etaTickStatus"
  | "etaTickClose"
  | "etaGanttToEarlier"
  | "etaGanttToLater"
  | "etaGroupToggle"
  | "etaGroupChat"
  | "etaGroupGantt"
  | "etaGroupWords"
  | "etaGroupUi"
  | "etaGroupImport"
  | "etaGroupAccount"
  | "etaGroupShip"
  | "etaGroupArch"
>;

/** The off-screen arrow's width (px): a row whose bar is past an edge of the view. */
const OFF_ARROW_W = 22;

const reducedMotion = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.dataset.motion === "off");

/**
 * The hint at the view's edge for a row whose bar lies wholly past it (owner,
 * 2026-11-14 05:00 JST): ◀ at the left (earlier), ▶ at the right (later). A
 * tap scrolls the bar into view. Drawn, not a glyph ("▶" is an emoji on iOS).
 */
function OffArrow({
  side,
  label,
  scrollX,
  viewW,
  h,
  onReveal,
}: {
  side: OffSide;
  label: string;
  scrollX: number;
  viewW: number;
  h: number;
  onReveal: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="debug-chat-gantt-off-arrow"
      data-side={side}
      aria-label={label}
      title={label}
      onClick={onReveal}
      className="absolute flex items-center justify-center rounded-sm p-0"
      style={{
        left: side === "earlier" ? scrollX : scrollX + viewW - OFF_ARROW_W,
        top: 0,
        width: OFF_ARROW_W,
        height: Math.min(h, ROW_H),
        zIndex: 4,
        border: 0,
        background: c("track"),
        color: c("late"),
        cursor: "pointer",
      }}
    >
      <svg aria-hidden="true" width={12} height={12} viewBox="0 0 12 12" fill="currentColor">
        <path d={side === "earlier" ? "M8 2.2 3 6 8 9.8Z" : "M4 2.2 9 6 4 9.8Z"} />
      </svg>
    </button>
  );
}

/** A tick's visible line (px): a change or a status change, a confirm (shorter), and its tap area. */
const TICK_W = 2;
const TICK_H = { change: 12, status: 12, confirm: 7 } as const;
const TICK_HIT = 16;

/** A label character's width at the axis's text size (the tick spacing reads it). */
const charPxOf = (el: HTMLElement) => {
  const fs = Number.parseFloat(getComputedStyle(el).fontSize);
  return Number.isFinite(fs) && fs > 0 ? (fs * 2) / 3 : CHAR_PX;
};

/** A child row's name is indented past its parent's ▸/▾. */
const CHILD_INDENT = "2.75rem";
/** The scroller's own touch-action: native pan, no page zoom (the double-tap drag sets none while armed). */
const PAN = "pan-x pan-y";

/** The ▸/▾ button's width (its height takes the row; .tap-40 makes it 40 px tall to the touch). */
const TOGGLE_W = 28;
/** A slice's tap area is at least this wide (px), however short its bar. */
const SLICE_MIN_HIT = 12;
/** A tapped slice's row stays marked this long (ms). */
const PICKED_MS = 2_000;

/** A line's height: a folded parent grows with its lanes (gantt-groups.ts groupRowH). */
const lineH = (l: GanttLine) =>
  l.kind === "group" && !l.open ? groupRowH(l.lanes, ROW_H) : ROW_H;

/** A row's state, for its styles and the QA. */
const stateOf = (t: EtaTask, now: number) =>
  t.done
    ? "done"
    : isParked(t)
      ? "parked"
      : t.queued
        ? "queued"
        : t.at <= now
          ? "reached"
          : "running";

/** A task's name in its row: the red mark when it waits for the owner, the name bold, the description muted. */
function TaskName({ t, strings }: { t: EtaTask; strings: Pick<Strings, "etaWaitingYou"> }) {
  const mark = parkMark(t);
  const { name, desc } = splitTitle(t.title);
  return (
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
  );
}

/** A task's time: its reminder when parked, else the time left (red, negative, past due), or done. */
function TaskTime({
  t,
  now,
  strings,
}: {
  t: EtaTask;
  now: number;
  strings: Pick<Strings, "etaWaitingYou" | "etaReminder" | "etaDone">;
}) {
  const left = t.at - now;
  if (isParked(t)) {
    // Parked: its time is when the reminder goes off, never work remaining.
    const reminder = strings.etaReminder.replace("{t}", compactTime(left));
    return (
      <span
        data-testid="debug-chat-gantt-time"
        data-parked={t.parked}
        className="shrink-0 tabular-nums"
        style={{ color: c("muted") }}
      >
        {parkMark(t) ? `${strings.etaWaitingYou} · ${reminder}` : reminder}
      </span>
    );
  }
  const late = !t.done && isLate(left);
  return (
    <span
      data-testid="debug-chat-gantt-time"
      data-late={late || undefined}
      className="shrink-0 tabular-nums"
      style={late ? { color: c("late"), fontWeight: 600 } : undefined}
    >
      {t.done ? strings.etaDone : etaLabel(t, now)}
    </span>
  );
}

/**
 * One task's bar in a box of its row (`top`, `h` px): the whole row (a task's
 * own row, an open parent's roll-up), or one lane of a folded parent
 * ("slice": thinner underline, no percent or arrow, no ghost). The ghost of
 * the original plan, the P5 → P95 tail, the bar (queued dashed, parked
 * hollow), the progress underline tinted by its pace, the overrun.
 */
function barMarks(
  t: EtaTask,
  axis: GanttAxis,
  now: number,
  nowX: number,
  top: number,
  h: number,
  mode: "row" | "slice",
) {
  const b = ganttBar(t, axis, now);
  const parked = isParked(t);
  // A range's tail (P5 → P95) on a running bar; queued, parked and done draw whole.
  const tail = !t.done && !t.queued && !parked ? b.w - b.solid : 0;
  // The original plan as a ghost; a done task's bar is how it really ran, so with no
  // recorded plan its estimate (start → at) is the ghost.
  const planned = t.plan ?? (t.done ? { start: t.start, at: t.at } : undefined);
  const plan = mode === "row" && planned ? ganttSpan(planned.start, planned.at, axis, now) : null;
  const ghost = plan && ghostShows(plan, b) ? plan : null;
  const big = h >= ROW_H;
  const gap = big ? UNDERLINE_GAP : Math.max(1, Math.round(h / 4));
  const ulH = big ? UNDERLINE_H : Math.max(1, gap - 1);
  const pad = big ? 0 : 0.5;
  const barBox = { top: top + pad, height: Math.max(1, h - gap - pad) };
  const testid = (s: string) => `debug-chat-gantt-${mode === "slice" ? `slice-${s}` : s}`;
  return (
    <>
      {ghost && (
        // The original plan (its first start and estimate): very faint, behind.
        <span
          aria-hidden
          data-testid="debug-chat-gantt-ghost"
          className="absolute rounded-sm"
          style={{ ...barBox, left: ghost.x, width: Math.max(3, ghost.w), background: c("ghost") }}
        />
      )}
      {tail > 0 && (
        // A range: from the P5 the bar fades out to the P95 (hatched under reduced motion).
        <span
          aria-hidden
          data-testid={testid("tail")}
          {...{ [TAIL_ATTR]: true }}
          className="absolute rounded-e-sm"
          style={
            {
              ...barBox,
              left: b.x + b.solid,
              width: tail,
              [TAIL_VAR]: c("bar"),
            } as CSSProperties
          }
        />
      )}
      <span
        aria-hidden
        data-testid={testid("bar")}
        className={`absolute overflow-hidden ${tail > 0 ? "rounded-s-sm" : "rounded-sm"}`}
        style={{
          ...barBox,
          left: b.x,
          width: Math.max(3, tail > 0 ? b.solid : b.w),
          background: c(t.done ? "done" : t.queued ? "queued" : "bar"),
          ...(t.queued ? { outline: `1px dashed ${c("muted")}`, outlineOffset: -1 } : {}),
          ...(parked ? parkedBar(c("bar"), c("muted")) : {}),
        }}
      />
      {!parked &&
        !t.queued &&
        b.fill > 0 &&
        (() => {
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
                data-testid={testid("progress")}
                data-pace={pace}
                data-gantt-line
                {...liveAttr}
                className="absolute rounded-full"
                style={{
                  left: b.x,
                  width: Math.max(2, b.fill),
                  top: top + h - ulH,
                  height: ulH,
                  background: ink,
                }}
              />
              {live && mode === "row" && (
                <span
                  aria-hidden
                  data-testid="debug-chat-gantt-frontier"
                  {...liveAttr}
                  className="absolute leading-none"
                  style={{ left: end - 1, top: top + h - 6, fontSize: 8, color: ink }}
                >
                  →
                </span>
              )}
              {mode === "row" && (
                <span
                  data-testid="debug-chat-gantt-pct"
                  className="absolute tabular-nums leading-none"
                  style={{
                    left: end + (live ? 9 : 2),
                    top: top + h - 9,
                    fontSize: 9,
                    color: c("muted"),
                  }}
                >
                  {Math.round(t.done ? 100 : (t.pct ?? 0))}%
                </span>
              )}
            </>
          );
        })()}
      {b.over > 0 && !parked && (
        <span
          aria-hidden
          data-testid={testid("over")}
          className="absolute rounded-e-sm"
          style={{
            ...barBox,
            left: b.x + b.w,
            width: b.over,
            background: c(t.done ? "done" : "past"),
          }}
        />
      )}
    </>
  );
}

export function GanttFull({
  tasks,
  now,
  strings,
  onClose,
  groups = GANTT_GROUPS,
}: {
  tasks: readonly EtaTask[];
  now: number;
  strings: Strings;
  onClose: () => void;
  /** The categories (gantt-groups.ts): the default table, or a config-store value. */
  groups?: readonly GanttGroupDef[];
}) {
  const rows = useMemo(() => ganttRowsByEnd(ganttPlan(tasks, now)), [tasks, now]);
  /** The categories this tab has open (session UI state); folded is the default. */
  const groupsOpen = useUi(ganttGroupsUi(), (s) => s.open);
  const lines = useMemo(
    () => ganttLines(rows, groups, groupsOpen, (g) => groupName(g, strings), now),
    [rows, groups, groupsOpen, strings, now],
  );
  /** Each line's height and top (px from the first line): a folded parent with many lanes is taller. */
  const geo = useMemo(() => {
    const hs = lines.map(lineH);
    const tops: number[] = [];
    let y = 0;
    for (const h of hs) {
      tops.push(y);
      y += h + ROW_GAP;
    }
    return { hs, tops, total: y };
  }, [lines]);
  const linesRef = useRef({ lines, geo });
  linesRef.current = { lines, geo };
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
  /** The tapped tick's change id: its group is shown, its ticks marked on every row. */
  const [sel, setSel] = useState<string | null>(null);
  const group = useMemo(
    () =>
      sel ? tickGroup(rows.map((r) => ({ ...r, title: splitTitle(r.title).name })), sel) : null,
    [rows, sel],
  );
  const selRef = useRef(sel);
  selRef.current = sel;

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
    // The line that holds it: its own (an open category), else its folded parent.
    const { lines: ls, geo: g } = linesRef.current;
    const fl = focus >= 0 ? lineOf(ls, rs[focus]!.id) : -1;
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
      i: fl,
      viewH: el.clientHeight,
      axisH: AXIS_H,
      headSpace: Math.round(GANTT_END_SPACE * el.clientHeight),
      rowH: g.hs[fl] ?? ROW_H,
      rowGap: ROW_GAP,
      before: g.tops[fl],
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
    /** Double-tap-and-drag (touch/pen): the machine, its zoom's start and where the pointer is now. */
    let tap: DbltapState = DBLTAP_IDLE;
    let drag: { from: ReturnType<typeof pinchStart>; factor: number; x: number } | null = null;
    /** The release after a drag zoom: its click (if the browser sends one) is not a tap. */
    let eatClick = false;
    let disarm = 0;
    /** A client x as px from the view's left edge (the scroller's own box). */
    const viewX = (clientX: number) => clientX - el.getBoundingClientRect().left - el.clientLeft;
    const flush = () => {
      frame = 0;
      if (drag) {
        const v = view.current;
        if (v) commit(pinchView(drag.from, drag.factor, viewX(drag.x), v.w, nowRef.current));
        return;
      }
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
    // Double-tap, then drag: the browser must not pan that second pointer, so
    // touch-action goes to none only while a second down would arm it (no
    // delay for a single tap, a single drag still pans natively).
    const hold = () => {
      el.style.touchAction = dbltapHolds(tap, performance.now()) ? "none" : PAN;
    };
    const apply = (r: DbltapStep) => {
      tap = r.state;
      const o = r.out;
      if (o?.type === "start") {
        const v = view.current;
        if (v)
          drag = {
            from: pinchStart(v.axis, pending.current ?? el.scrollLeft, viewX(o.x), nowRef.current),
            factor: 1,
            x: o.x,
          };
      } else if (o?.type === "zoom" && drag) {
        drag.factor = o.factor;
        drag.x = o.x;
        frame ||= requestAnimationFrame(flush);
      } else if (o?.type === "end") {
        // The last move waiting for its frame lands first.
        if (frame && drag) {
          cancelAnimationFrame(frame);
          flush();
        }
        drag = null;
        eatClick = true;
      }
      hold();
      clearTimeout(disarm);
      // Armed but no second down in time: give the browser its pan back.
      if (tap.kind === "armed") disarm = window.setTimeout(hold, DBLTAP.gapMs + 1);
    };
    const pt = (e: PointerEvent): DbltapPointer => ({
      id: e.pointerId,
      type: e.pointerType,
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
    });
    const pDown = (e: PointerEvent) => {
      eatClick = false;
      apply(dbltapDown(tap, pt(e)));
    };
    const pMove = (e: PointerEvent) => {
      if (tap.kind === "idle" || tap.kind === "armed") return;
      apply(dbltapMove(tap, pt(e)));
    };
    const pUp = (e: PointerEvent) => apply(dbltapUp(tap, pt(e)));
    const pCancel = () => apply(dbltapCancel(tap));
    const click = (e: MouseEvent) => {
      if (!eatClick) return;
      eatClick = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // iOS before touch-action took hold: a live drag zoom never scrolls.
    const tMove = (e: TouchEvent) => {
      if (tap.kind === "zoom" && e.touches.length === 1) e.preventDefault();
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
    el.addEventListener("pointerdown", pDown);
    el.addEventListener("pointermove", pMove);
    el.addEventListener("pointerup", pUp);
    el.addEventListener("pointercancel", pCancel);
    el.addEventListener("click", click, true);
    el.addEventListener("touchmove", tMove, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", pDown);
      el.removeEventListener("pointermove", pMove);
      el.removeEventListener("pointerup", pUp);
      el.removeEventListener("pointercancel", pCancel);
      el.removeEventListener("click", click, true);
      el.removeEventListener("touchmove", tMove);
      clearTimeout(disarm);
      el.style.touchAction = PAN;
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
      // A tick's note open: Escape closes it first.
      if (selRef.current) setSel(null);
      else close.current();
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
  /** An off-screen arrow's tap: scroll so that bar is in view (at once under reduced motion). */
  const reveal = (bar: { x: number; w: number }) => {
    const el = scroller.current;
    if (!el) return;
    const left = revealScrollLeft(bar, { width: el.clientWidth }, el.scrollWidth);
    el.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
  };
  /** The arrow for a row whose bar is past an edge of the view, if it is. */
  const offArrow = (bar: { x: number; w: number }, title: string, h: number) => {
    const side = offScreenSide(bar, { left: scrollX, width: w });
    if (!side) return null;
    const label = (side === "earlier" ? strings.etaGanttToEarlier : strings.etaGanttToLater).replace(
      "{task}",
      title,
    );
    return (
      <OffArrow
        side={side}
        label={label}
        scrollX={scrollX}
        viewW={w}
        h={h}
        onReveal={() => reveal(bar)}
      />
    );
  };

  /** ▸/▾: a category's children as their own rows, or folded onto its one row. */
  const toggle = (id: string) =>
    ganttGroupsUi().setState((s) => ({ open: toggleOpen(s.open, id) }));
  /** The child a tapped slice opened: its row is centred and marked a moment. */
  const [picked, setPicked] = useState<string | null>(null);
  const revealRef = useRef<string | null>(null);
  const openChild = (group: string, id: string) => {
    const ui = ganttGroupsUi();
    if (!ui.getState().open.includes(group)) ui.setState((s) => ({ open: [...s.open, group] }));
    revealRef.current = id;
    setPicked(id);
  };
  useLayoutEffect(() => {
    const id = revealRef.current;
    const el = scroller.current;
    if (!id || !el) return;
    const i = lineOf(lines, id);
    if (i < 0 || lines[i]!.kind !== "task") return;
    revealRef.current = null;
    el.scrollTop = centreRowTop({
      i,
      viewH: el.clientHeight,
      axisH: AXIS_H,
      headSpace: Math.round(GANTT_END_SPACE * el.clientHeight),
      rowH: geo.hs[i]!,
      rowGap: ROW_GAP,
      before: geo.tops[i],
    });
  }, [lines, geo]);
  useEffect(() => {
    if (!picked) return;
    const t = setTimeout(() => setPicked(null), PICKED_MS);
    return () => clearTimeout(t);
  }, [picked]);

  const width = axis ? scaleWidth(axis) : 0;
  const ticks = axis ? scaleTicks(axis, scrollX, w, now, charPx) : [];
  const nowX = axis ? scaleX(axis, now, now) : 0;
  /** Blank space at the head and the tail of the rows (GANTT_END_SPACE of the view). */
  const endSpace = Math.round(GANTT_END_SPACE * viewH);
  const bodyH = geo.total + 2 * endSpace;

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
      <style>{LIVE_CSS + TAIL_CSS}</style>
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
        className="m-0 shrink-0 px-3 py-0.5 fs-10"
        style={{ color: c("muted"), borderBottom: `1px solid ${c("grid")}` }}
      >
        {strings.etaGanttLegend} · {strings.etaGanttLegendTicks}
      </p>
      <div
        ref={scroller}
        data-testid="debug-chat-gantt-scroll"
        dir="ltr"
        onScroll={onScroll}
        className="min-h-0 flex-1"
        style={{ overflow: "auto", overscrollBehavior: "contain", touchAction: PAN }}
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
              lines.map((l, li) => {
                const h = geo.hs[li]!;
                if (l.kind === "task") {
                  const t = l.task;
                  const on = picked === t.id;
                  const tb = ganttBar(t, axis, now);
                  const tBar = { x: tb.x, w: tb.w + (isParked(t) ? 0 : tb.over) };
                  const tOff = offScreenSide(tBar, { left: scrollX, width: w });
                  return (
                    <li
                      key={l.key}
                      data-testid="debug-chat-gantt-row"
                      data-id={t.id}
                      data-state={stateOf(t, now)}
                      data-group={l.group ?? undefined}
                      data-picked={on || undefined}
                      className="relative flex items-center"
                      style={{
                        height: h,
                        marginBottom: ROW_GAP,
                        ...(on ? { outline: `2px solid ${c("muted")}`, outlineOffset: -2 } : {}),
                      }}
                    >
                      {barMarks(t, axis, now, nowX, 0, h, "row")}
                      {offArrow(tBar, splitTitle(t.title).name, h)}
                      {(t.ticks ?? []).map((ev, i) => {
                        // The estimate's history: a short tick per event; one action's line up.
                        const x = ganttTickX(ev.at, axis, now);
                        if (x === null) return null;
                        const sel1 = ev.changeId === sel;
                        return (
                          <button
                            key={`${ev.changeId}:${i}`}
                            type="button"
                            data-testid="debug-chat-gantt-eta-tick"
                            data-kind={ev.kind}
                            data-change={ev.changeId}
                            data-selected={sel1 || undefined}
                            aria-label={`${axisLabel(ev.at - now)} · ${ev.by}`}
                            aria-pressed={sel1}
                            onClick={() => setSel(sel1 ? null : ev.changeId)}
                            className="absolute p-0"
                            style={{
                              left: x - TICK_HIT / 2,
                              top: 0,
                              width: TICK_HIT,
                              height: ROW_H - UNDERLINE_GAP,
                              zIndex: 2,
                              border: 0,
                              background: "transparent",
                              cursor: "pointer",
                            }}
                          >
                            <span
                              aria-hidden
                              className="absolute"
                              style={{
                                left: (TICK_HIT - TICK_W) / 2,
                                top: 0,
                                width: sel1 ? TICK_W + 1 : TICK_W,
                                height: sel1 ? ROW_H - UNDERLINE_GAP : TICK_H[ev.kind],
                                background:
                                  ev.kind === "status"
                                    ? `repeating-linear-gradient(180deg, ${c(sel1 ? "text" : "tick")} 0 3px, transparent 3px 5px)`
                                    : c(sel1 ? "text" : "tick"),
                              }}
                            />
                          </button>
                        );
                      })}
                      {/* The name: pinned at the left of what is visible, over the bar; a child indented. */}
                      <span
                        data-testid="debug-chat-gantt-name"
                        title={t.title}
                        className="flex min-w-0 items-baseline gap-1.5 px-2"
                        style={{
                          position: "sticky",
                          // Clear of the ◀ when the bar is past the left edge.
                          left: tOff === "earlier" ? OFF_ARROW_W : 0,
                          zIndex: 1,
                          maxWidth: "min(36rem, calc(100vw - 1rem))",
                          ...(l.group ? { paddingInlineStart: CHILD_INDENT } : {}),

                        }}
                      >
                        <TaskName t={t} strings={strings} />
                        <TaskTime t={t} now={now} strings={strings} />
                      </span>
                    </li>
                  );
                }
                // A parent: its children's bars on its one row (folded), or its own roll-up (open).
                const p = l.task;
                const span = ganttBar(p, axis, now);
                const name = p.title;
                const pBar = { x: span.x, w: span.w + span.over };
                const pOff = offScreenSide(pBar, { left: scrollX, width: w });
                const openAt = l.children.reduce(
                  (m, x) => (x.done ? m : Math.max(m, x.at)),
                  -Infinity,
                );
                return (
                  <li
                    key={l.key}
                    data-testid="debug-chat-gantt-group"
                    data-id={l.def.id}
                    data-state={stateOf(p, now)}
                    data-open={l.open}
                    data-lanes={l.lanes}
                    data-count={l.children.length}
                    className="relative flex items-center"
                    style={{ height: h, marginBottom: ROW_GAP }}
                  >
                    {/* The parent's span: from its earliest start to its latest end. */}
                    <span
                      aria-hidden
                      data-testid="debug-chat-gantt-span"
                      className="absolute rounded-sm"
                      style={{
                        top: 0,
                        bottom: 0,
                        left: span.x,
                        width: Math.max(3, span.w + span.over),
                        outline: `1px solid ${c("grid")}`,
                        outlineOffset: -1,
                      }}
                    />
                    {offArrow(pBar, name, h)}
                    {l.open
                      ? barMarks(p, axis, now, nowX, 0, h, "row")
                      : l.children.map((x, i) => {
                          const lb = laneBox(l.lane[i]!, l.lanes, h);
                          const b = ganttBar(x, axis, now);
                          const mark = parkMark(x);
                          const { name: xn } = splitTitle(x.title);
                          return (
                            <Fragment key={x.id}>
                              {barMarks(x, axis, now, nowX, lb.top, lb.h, "slice")}
                              {/* A tap on a slice opens its category and centres that task's row. */}
                              <button
                                type="button"
                                data-testid="debug-chat-gantt-slice"
                                data-id={x.id}
                                data-lane={l.lane[i]}
                                data-state={stateOf(x, now)}
                                aria-label={`${xn} · ${x.done ? strings.etaDone : etaLabel(x, now)}`}
                                title={x.title}
                                onClick={() => openChild(l.def.id, x.id)}
                                className="absolute p-0"
                                style={{
                                  left: b.x,
                                  top: lb.top,
                                  width: Math.max(SLICE_MIN_HIT, b.w + (isParked(x) ? 0 : b.over)),
                                  height: lb.h,
                                  zIndex: 2,
                                  border: 0,
                                  background: "transparent",
                                  cursor: "pointer",
                                }}
                              >
                                {mark && (
                                  // Waits for the owner: the red "!" ("?" for a decision) at the slice's start.
                                  <span
                                    aria-hidden
                                    data-testid="debug-chat-gantt-slice-mark"
                                    className="absolute font-bold leading-none"
                                    style={{
                                      left: 1,
                                      top: "50%",
                                      transform: "translateY(-50%)",
                                      fontSize: Math.max(8, Math.min(11, lb.h)),
                                      color: c("late"),
                                    }}
                                  >
                                    {mark}
                                  </span>
                                )}
                              </button>
                            </Fragment>
                          );
                        })}
                    <span
                      data-testid="debug-chat-gantt-name"
                      title={name}
                      className="flex min-w-0 items-center gap-1 pe-2"
                      style={{
                        position: "sticky",
                        left: pOff === "earlier" ? OFF_ARROW_W : 0,
                        zIndex: 3,
                        maxWidth: "min(36rem, calc(100vw - 1rem))",
                        borderRadius: 4,
                        ...(l.open ? {} : { background: c("chip") }),

                      }}
                    >
                      <button
                        type="button"
                        data-testid="debug-chat-gantt-toggle"
                        aria-expanded={l.open}
                        aria-label={strings.etaGroupToggle.replace("{group}", name)}
                        title={strings.etaGroupToggle.replace("{group}", name)}
                        onClick={() => toggle(l.def.id)}
                        className="tap-40 shrink-0 rounded p-0 leading-none"
                        style={{
                          width: TOGGLE_W,
                          height: ROW_H - 4,
                          border: 0,
                          background: "transparent",
                          color: c("text"),
                          cursor: "pointer",
                        }}
                      >
                        <Disclosure open={l.open} size={12} />
                      </button>
                      <span dir="auto" className="min-w-0 truncate">
                        {l.mark && (
                          <span
                            role="img"
                            aria-label={strings.etaWaitingYou}
                            title={strings.etaWaitingYou}
                            data-testid="debug-chat-gantt-mark"
                            className="me-1 font-bold"
                            style={{ color: c("late") }}
                          >
                            {l.mark}
                          </span>
                        )}
                        <span className="font-semibold">{name}</span>
                        <span style={{ color: c("muted") }}> ×{l.children.length}</span>
                      </span>
                      <span
                        data-testid="debug-chat-gantt-time"
                        data-late={(!p.done && openAt <= now) || undefined}
                        className="shrink-0 tabular-nums"
                        style={
                          !p.done && isLate(openAt - now)
                            ? { color: c("late"), fontWeight: 600 }
                            : undefined
                        }
                      >
                        {p.done
                          ? strings.etaDone
                          : p.parked
                            ? strings.etaReminder.replace("{t}", compactTime(openAt - now))
                            : compactTime(openAt - now)}
                      </span>
                      <span
                        data-testid="debug-chat-gantt-group-pct"
                        className="shrink-0 tabular-nums"
                        style={{ color: c("muted") }}
                      >
                        {p.pct ?? 0}%
                      </span>
                    </span>
                  </li>
                );
              })}
          </ul>
        </div>
      </div>
      {group && (
        // A tapped tick: what that one action did across the rows.
        <div
          role="status"
          data-testid="debug-chat-gantt-tick-note"
          className="absolute flex items-start gap-2 rounded px-3 py-2 fs-12"
          style={{
            left: 8,
            right: 8,
            bottom: "calc(8px + env(safe-area-inset-bottom))",
            zIndex: 4,
            background: c("track"),
            color: c("text"),
            border: `1px solid ${c("grid")}`,
            boxShadow: "0 2px 10px oklch(0 0 0 / 0.18)",
          }}
        >
          <div className="min-w-0 flex-1">
            <div className="tabular-nums fs-10" style={{ color: c("muted") }}>
              {axisLabel(group.at - now)} · {group.by.join(", ")}
            </div>
            <div dir="auto" data-testid="debug-chat-gantt-tick-text">
              {tickGroupText(group, {
                earlier: strings.etaTickEarlier,
                later: strings.etaTickLater,
                confirmed: strings.etaTickConfirmed,
                set: strings.etaTickSet,
                status: strings.etaTickStatus,
              })}
            </div>
          </div>
          <button
            type="button"
            data-testid="debug-chat-gantt-tick-close"
            aria-label={strings.etaTickClose}
            title={strings.etaTickClose}
            onClick={() => setSel(null)}
            className="tap-40 shrink-0 rounded px-2"
            style={{ color: c("text"), background: "transparent", border: 0 }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
