"use client";

// The grade handle on the reader's selection card (owner, 2026-11-05
// 02:52–03:20 JST: "点击句子之后允许在浮动卡片上拖动一个handle去评分",
// "handle本身可以内部不包括内容", "专门放中间用来拖"): a plain round knob
// resting in the middle of a short track, there only to be dragged. Left or
// right grades by the /words swipe's own levels, feel and release rule
// (lib/read/grade-handle.ts over lib/words/swipe.ts; the core reports the
// default side's grade, the mirror setting is applied here, once); up takes
// the last batch back when there is one. While dragging, the track takes the
// grade's colour and the hint line above it names what will be graded; the
// knob springs back to the middle on release. A tap never grades, and a
// press that starts inside the gesture that opened the card is ignored.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { useIntlayer } from "next-intlayer";
import { fill } from "@/lib/nav/nav-core";
import { hintParts, type HandlePlan } from "@/lib/read/batch-grade";
import { afterGrade, LEVEL_KEY } from "@/lib/read/review-scope";
import { followSwipe } from "@/lib/words/swipe-physics";
import { SWIPE_CORE_IFACE, useSwipeFeel } from "@/lib/words/swipe-core";
import {
  releaseVelocity,
  sideRating,
  SWIPE_ROW_PX,
  type Axis,
  type SwipeLevel,
  type SwipeRating,
} from "@/lib/words/swipe";
import {
  handleMove,
  handleRelease,
  levelGrade,
  openingPress,
  relTime,
  UNDO_PX,
} from "@/lib/read/grade-handle";

type GradePlan = Extract<HandlePlan, { mode: "grade" }>;

/** The handle's words: what a batch is called, and the hint line. */
export function useGradeWords() {
  const t = useIntlayer("read-grade-handle");
  const tw = useIntlayer("words-page");
  const nf = (n: number) => String(n);
  const targetName = (p: GradePlan, n: number) =>
    p.target === "sentences" ? fill(t.sentences.value, { n: nf(n) }) : t[p.target].value;
  const grades: Record<SwipeRating, string> = {
    1: tw.again.value,
    2: tw.hard.value,
    3: tw.good.value,
    4: tw.easy.value,
  };
  /**
   * The levels' names on the handle: a paragraph's say what they do (owner,
   * 2026-11-08 21:43 JST; lib/read/review-scope.ts afterGrade) — 本段 / 到本段 /
   * (grade only) / 全标简单; anything else keeps the grade names.
   */
  const levels = (p: GradePlan): Record<SwipeRating, string> => {
    if (p.target !== "para") return grades;
    const out = {} as Record<SwipeRating, string>;
    for (const r of [1, 2, 3, 4] as const) {
      const k = LEVEL_KEY[afterGrade(r)];
      out[r] = k ? t[k].value : PLAIN_LEVEL;
    }
    return out;
  };
  /** "这 3 句 + 12 个词": the batch a grade `r` makes. */
  const describe = (p: GradePlan, r: SwipeRating) => {
    const h = hintParts(p, r);
    return h.words
      ? `${targetName(p, h.n)} ${fill(t.plusWords.value, { n: nf(h.words) })}`
      : targetName(p, h.n);
  };
  const hint = (
    p: GradePlan,
    s: { rating: SwipeRating | null; undo: boolean },
    lastWhat: string | null,
    intervals: Record<SwipeRating, string | null> | null = null,
  ) => {
    if (s.undo && lastWhat) return fill(t.undo.value, { what: lastWhat });
    const h = hintParts(p, s.rating);
    const skipped = h.skipped ? ` ${fill(t.skipped.value, { n: nf(h.skipped) })}` : "";
    if (!s.rating) return `${lastWhat ? t.idleUndo.value : t.idle.value}${skipped}`;
    const words = h.words ? ` ${fill(t.plusWords.value, { n: nf(h.words) })}` : "";
    // The grade with the interval it gives, as /words shows it ("良好 · 3d").
    const iv = intervals?.[s.rating];
    const name = levels(p)[s.rating];
    const grade = iv ? `${name} · ${iv}` : name;
    return `${fill(t.graded.value, { target: targetName(p, h.n), grade })}${words}${skipped}`;
  };
  return { describe, hint, grades, levels };
}

/**
 * A new word's strip (owner, 2026-11-06 15:56 JST): the word is only a preview
 * and nothing of it is stored; the knob's grade is what adds it. Past a level,
 * or one of the buttons (keyboard, screen reader; hidden until focused), calls
 * `onCommit`; short of a level, or leaving, nothing happens. It knows no plan,
 * book or endpoint, so any surface that shows an uncarded word can use it.
 */
export function NewWordStrip({
  context,
  intervals,
  mirror,
  openedAt,
  canUndo,
  lastWhat,
  onPreview,
  onCommit,
  onUndo,
}: {
  /** The sentence the word was met in (shown as the preview's context). */
  context?: string | null;
  intervals: Record<SwipeRating, string | null> | null;
  mirror: boolean;
  openedAt: number;
  canUndo: boolean;
  lastWhat: string | null;
  onPreview: (r: SwipeRating | null, undo: boolean) => void;
  onCommit: (r: SwipeRating) => void;
  onUndo: () => void;
}) {
  const t = useIntlayer("read-grade-handle");
  const { grades } = useGradeWords();
  const named = (r: SwipeRating) => (intervals?.[r] ? `${grades[r]} · ${intervals[r]}` : grades[r]);
  return (
    <>
      {context && (
        <p className="mt-1 line-clamp-3 text-sm opacity-75" data-testid="read-new-word-context">
          {context}
        </p>
      )}
      <GradeHandle
        enabled
        reason={null}
        label={t.addKnob.value}
        canUndo={canUndo}
        mirror={mirror}
        openedAt={openedAt}
        hint={(s) =>
          s.undo && lastWhat
            ? fill(t.undo.value, { what: lastWhat })
            : s.rating
              ? fill(t.previewAdd.value, { grade: named(s.rating) })
              : t.previewIdle.value
        }
        onPreview={onPreview}
        onGrade={onCommit}
        onUndo={onUndo}
      />
      <KeyRow intervals={intervals} grades={grades} />
      <div className="flex flex-wrap justify-center gap-1">
        {([1, 2, 3, 4] as const).map((r) => (
          <button
            key={r}
            type="button"
            data-testid="read-new-word-add"
            data-rating={r}
            className="sr-only min-h-11 rounded-full px-3 text-sm focus:not-sr-only focus:bg-[oklch(0.5_0_0/0.1)] focus:px-3"
            onClick={(e) => {
              // The button goes with the strip: after this click has bubbled (gone by
              // then, it would count as a click off the card), and focus stays on the
              // card, on the knob (undo).
              const card = e.currentTarget.closest("[data-select-card]");
              setTimeout(() => {
                flushSync(() => onCommit(r));
                card?.querySelector<HTMLElement>("[role=slider]")?.focus();
              }, 0);
            }}
          >
            {fill(t.addAs.value, { grade: named(r) })}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * The card's grade area for the plan: when it is due for one not due, a new
 * word's strip for a word or phrase with no card, else the handle — and,
 * briefly after a grade, when it comes back.
 */
export function CardGradeArea({
  plan,
  intervals = null,
  context = null,
  locale,
  mirror,
  openedAt,
  canUndo,
  lastWhat,
  next,
  onNextShown,
  onPreview,
  onGrade,
  onUndo,
}: {
  plan: HandlePlan;
  /** Each grade's next interval ("3d", "1d–5d"), null while unknown. */
  intervals?: Record<SwipeRating, string | null> | null;
  /** A word with no card: the sentence it was met in. */
  context?: string | null;
  locale: string;
  mirror: boolean;
  openedAt: number;
  canUndo: boolean;
  lastWhat: string | null;
  next: string | null;
  onNextShown: () => void;
  onPreview: (r: SwipeRating | null, undo: boolean) => void;
  onGrade: (r: SwipeRating) => void;
  onUndo: () => void;
}) {
  const t = useIntlayer("read-grade-handle");
  const words = useGradeWords();
  useEffect(() => {
    if (!next) return;
    const id = setTimeout(onNextShown, 5000);
    return () => clearTimeout(id);
  }, [next, onNextShown]);
  const nextLine = next && (
    <p className="mt-1 text-center text-xs opacity-75" role="status" data-testid="read-grade-next">
      {fill(t.nextAt.value, { when: relTime(next, locale) })}
    </p>
  );
  // Nothing to grade here, but the last batch can still be taken back: the knob, up only.
  const undoOnly = (reason: string | null) =>
    canUndo && (
      <GradeHandle
        enabled={false}
        reason={reason}
        canUndo
        mirror={mirror}
        openedAt={openedAt}
        hint={(s) => (s.undo && lastWhat ? fill(t.undo.value, { what: lastWhat }) : (reason ?? ""))}
        onPreview={onPreview}
        onGrade={onGrade}
        onUndo={onUndo}
      />
    );
  if (plan.mode === "notDue")
    return (
      <>
        {nextLine}
        {!next && !canUndo && (
          <p className="mt-1.5 text-center text-xs opacity-75" data-testid="read-grade-due">
            {fill(t.dueAt.value, { when: relTime(plan.due, locale) })}
          </p>
        )}
        {undoOnly(fill(t.dueAt.value, { when: relTime(plan.due, locale) }))}
      </>
    );
  if (plan.mode !== "grade")
    return (
      <>
        {nextLine}
        {undoOnly(null)}
      </>
    );
  if (plan.preview)
    return (
      <NewWordStrip
        context={context}
        intervals={intervals}
        mirror={mirror}
        openedAt={openedAt}
        canUndo={canUndo}
        lastWhat={lastWhat}
        onPreview={onPreview}
        onCommit={onGrade}
        onUndo={onUndo}
      />
    );
  return (
    <>
      <GradeHandle
        enabled={!plan.disabled}
        reason={plan.disabled ? t.nothingDue.value : null}
        canUndo={canUndo}
        mirror={mirror}
        openedAt={openedAt}
        hint={(s) => words.hint(plan, s, canUndo ? lastWhat : null, intervals)}
        names={words.levels(plan)}
        onPreview={onPreview}
        onGrade={onGrade}
        onUndo={onUndo}
      />
      {!plan.disabled && <KeyRow intervals={intervals} grades={words.levels(plan)} />}
      {nextLine}
    </>
  );
}

/** A paragraph's level that only grades (Good by default): no words of its own. */
const PLAIN_LEVEL = "—";

/** A mouse and a keyboard: the four grade keys, each with its grade and interval. */
const FINE = "(hover: hover) and (pointer: fine)";
function KeyRow({
  intervals,
  grades,
}: {
  intervals: Record<SwipeRating, string | null> | null;
  grades: Record<SwipeRating, string>;
}) {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const m = window.matchMedia?.(FINE);
    if (!m) return;
    setFine(m.matches);
    const on = () => setFine(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  if (!fine) return null;
  // Keys name grades, not sides: 1–4, and L K J H (lib/words/swipe.ts KEY_RATING).
  const alt: Record<SwipeRating, string> = { 1: "L", 2: "K", 3: "J", 4: "H" };
  return (
    <p
      className="mt-1 flex flex-wrap justify-center gap-x-3 text-xs tabular-nums opacity-75"
      data-testid="read-grade-keys"
    >
      {([1, 2, 3, 4] as const).map((r) => (
        <span key={r} data-rating={r} title={`${r} / ${alt[r]}`}>
          <kbd className="me-1 rounded border border-[var(--glass-line)] px-1 font-sans">{r}</kbd>
          {grades[r]}
          {intervals?.[r] && <span className="ms-1 opacity-80">{intervals[r]}</span>}
        </span>
      ))}
    </p>
  );
}

const TINT: Record<SwipeRating, string> = {
  1: "var(--slip-again)",
  2: "var(--slip-hard)",
  3: "var(--slip-good)",
  4: "var(--slip-easy)",
};

type Drag = {
  id: number;
  x0: number;
  y0: number;
  axis: Axis | null;
  held: SwipeLevel;
  undo: boolean;
  samples: { t: number; x: number }[];
  dx: number;
  dy: number;
};

export function GradeHandle({
  enabled,
  reason,
  label,
  canUndo,
  mirror,
  openedAt,
  hint,
  names: levelNames,
  onPreview,
  onGrade,
  onUndo,
}: {
  /** Something here is due or new. */
  enabled: boolean;
  /** Why it is greyed out (nothing due). */
  reason: string | null;
  /** The knob's name for a screen reader, when it is not a plain grade. */
  label?: string;
  /** A batch made with the handle can be taken back (drag up). */
  canUndo: boolean;
  mirror: boolean;
  /** performance.now() when the card opened on this selection. */
  openedAt: number;
  /** The hint line for a grade being dragged (mirror applied), the undo, or idle. */
  hint: (state: { rating: SwipeRating | null; undo: boolean }) => string;
  /** Each level's name for a screen reader, when not the grade names (a paragraph's). */
  names?: Record<SwipeRating, string>;
  /** The grade being dragged changed (null: none): the targets pulse. */
  onPreview: (r: SwipeRating | null, undo: boolean) => void;
  onGrade: (r: SwipeRating) => void;
  onUndo: () => void;
}) {
  const t = useIntlayer("read-grade-handle");
  const tw = useIntlayer("words-page");
  const { feel, reducedMotion } = useSwipeFeel(SWIPE_CORE_IFACE);
  const knob = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [shown, setShown] = useState<{ rating: SwipeRating | null; undo: boolean }>({
    rating: null,
    undo: false,
  });
  const a = SWIPE_ROW_PX;

  const place = (x: number, y: number, animate: boolean) => {
    const el = knob.current;
    if (!el) return;
    el.style.transition =
      animate && !reducedMotion ? "transform 0.28s cubic-bezier(.2,.9,.3,1.2)" : "none";
    el.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  };
  const last = useRef(shown);
  const show = (rating: SwipeRating | null, undo: boolean) => {
    if (rating === last.current.rating && undo === last.current.undo) return;
    last.current = { rating, undo };
    setShown(last.current);
    onPreview(rating, undo);
  };
  const end = () => {
    drag.current = null;
    place(0, 0, true);
    show(null, false);
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    // The tap that opened the card is not a press on its handle.
    if (!(enabled || canUndo) || openingPress(openedAt, performance.now())) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      axis: null,
      held: 0,
      undo: false,
      samples: [{ t: performance.now(), x: 0 }],
      dx: 0,
      dy: 0,
    };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dx = e.clientX - d.x0;
    d.dy = e.clientY - d.y0;
    const now = performance.now();
    d.samples = [...d.samples.filter((s) => now - s.t < 200), { t: now, x: d.dx }];
    const m = handleMove(d.dx, d.dy, d.axis, d.held, a);
    d.axis = m.axis;
    if (m.axis === "h" && !enabled) {
      // Undo only (nothing here to grade): sideways does nothing.
      place(0, 0, false);
    } else if (m.axis === "h") {
      if (m.level !== d.held) navigator.vibrate?.(Math.abs(m.level) === 2 ? 12 : 6);
      d.held = m.level;
      place(followSwipe(d.dx, feel, a), 0, false);
      const g = levelGrade(m.level);
      show(g ? sideRating(g, mirror) : null, false);
    } else if (m.axis === "v") {
      // Up only, and only with something to undo; a little give otherwise.
      const y = canUndo
        ? Math.max(-UNDO_PX * 1.4, Math.min(0, d.dy))
        : Math.max(-8, Math.min(0, d.dy * 0.2));
      place(0, y, false);
      const armed = canUndo && m.undo;
      if (armed !== d.undo) navigator.vibrate?.(8);
      d.undo = armed;
      show(null, armed);
    }
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const r = handleRelease({
      axis: d.axis,
      dx: d.dx,
      dy: d.dy,
      v: releaseVelocity(d.samples, performance.now()),
      held: d.held,
      canUndo,
      a,
    });
    end();
    if (r.kind === "grade" && enabled) onGrade(sideRating(r.raw, mirror));
    else if (r.kind === "undo") onUndo();
  };

  const names = levelNames ?? {
    1: tw.again.value,
    2: tw.hard.value,
    3: tw.good.value,
    4: tw.easy.value,
  };
  const tint = shown.rating ? TINT[shown.rating] : shown.undo ? "oklch(0.6 0.02 250 / 0.3)" : null;
  return (
    <div className="mt-1.5" data-testid="read-grade-handle" data-enabled={enabled || undefined}>
      <p
        className="min-h-5 text-center text-xs tabular-nums opacity-80"
        aria-live="polite"
        data-testid="read-grade-hint"
      >
        {enabled || shown.undo ? hint(shown) : reason}
      </p>
      <div
        className="relative mx-auto mt-1 h-12 max-w-[20rem] rounded-full bg-[oklch(0.5_0_0/0.1)] transition-colors"
        style={tint ? { background: tint } : undefined}
        data-grade={shown.rating ?? undefined}
        data-undo={shown.undo || undefined}
      >
        {canUndo && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-0.5 left-1/2 -translate-x-1/2 text-[0.6rem] leading-none opacity-45"
          >
            ˄
          </span>
        )}
        <div
          ref={knob}
          role="slider"
          tabIndex={enabled || canUndo ? 0 : -1}
          aria-label={label ?? t.knobLabel.value}
          aria-disabled={!(enabled || canUndo) || undefined}
          aria-valuemin={1}
          aria-valuemax={4}
          aria-valuenow={shown.rating ?? undefined}
          aria-valuetext={
            shown.rating ? names[shown.rating] : shown.undo ? t.undone.value : undefined
          }
          data-testid="read-grade-knob"
          className={`absolute top-1/2 left-1/2 h-11 w-11 rounded-full border border-[var(--glass-line)] bg-[var(--background)] shadow-[0_2px_8px_-2px_oklch(0.22_0.015_65/0.45)] ${
            enabled || canUndo ? "cursor-grab active:cursor-grabbing" : "opacity-40"
          }`}
          style={{ transform: "translate(-50%, -50%)", touchAction: "none" }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => drag.current && end()}
          onLostPointerCapture={() => drag.current && end()}
        />
      </div>
    </div>
  );
}
