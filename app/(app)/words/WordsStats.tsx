"use client";

/**
 * The /words list picker's stats strip: folded, one line (the last week's
 * cells, streak, new today; due is on Study all just below); open, four headline counts and a six-month
 * study heatmap, one cell per local day. The heatmap's look is switchable
 * (seals, 正 tallies, ink dots, bamboo slips) while the owner compares them;
 * the choice is this device's (`lk:pref:words-stats-look`). So is the layout
 * (`lk:pref:words-stats-variant`, lib/words/stats.ts `VARIANTS`): how much
 * calendar it shows a new user, while the owner picks one; the owner (or
 * debug mode) can also simulate a new user's short history from his own.
 *
 * Data: the counts already on the lists (cards, due) plus one GET
 * /api/words/stats when the picker opens. Nothing polls.
 */
import "./stats.css";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { createUiStore, useUi } from "@lianki/ui-state";
import { Icon } from "@/app/components/icons";
import { fill } from "@/lib/nav/nav-core";
import { longDate } from "@/lib/dates";
import { DEBUG_EVENT, debugOn } from "@/lib/debug-client";
import {
  STATS_WEEKS,
  VARIANTS,
  activeDays,
  dayKey,
  gridFor,
  inkScale,
  sealTilt,
  shiftDay,
  simulateHistory,
  streak,
  sumByDay,
  todayVsUsual,
  tooShort,
  tzName,
  tzOffset,
  type StatsTuple,
  type Variant,
  WEEK,
} from "@/lib/words/stats";
import { wordsUiStore } from "./ui-store";

export const LOOKS = ["seal", "tally", "ink", "slip"] as const;
export type Look = (typeof LOOKS)[number];

const lookStore = createUiStore<{ look: Look }>(
  "words-stats-look",
  1,
  { look: "seal" },
  {
    storage: "local",
    clean: (raw) => {
      const v = (raw ?? {}) as { look?: unknown };
      return LOOKS.includes(v.look as Look) ? { look: v.look as Look } : {};
    },
  },
);

const variantStore = createUiStore<{ variant: Variant }>(
  "words-stats-variant",
  1,
  { variant: "full" },
  {
    storage: "local",
    clean: (raw) => {
      const v = (raw ?? {}) as { variant?: unknown };
      return VARIANTS.includes(v.variant as Variant) ? { variant: v.variant as Variant } : {};
    },
  },
);

/** History lengths the owner can pretend to have (test views, not user numbers). */
const SIM_DAYS = [1, 4, 12, 40] as const;

/** Debug mode (lib/debug-client.ts), following its switch. */
function useDebugOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => setOn(debugOn());
    read();
    window.addEventListener(DEBUG_EVENT, read);
    return () => window.removeEventListener(DEBUG_EVENT, read);
  }, []);
  return on;
}

type Level = 0 | 1 | 2 | 3 | 4;

export default function WordsStats({
  base,
  listIds,
  learned,
  due,
  owner = false,
}: {
  /** The page (/words, /alphabets): its own folded/open state. */
  base: string;
  /** The lists this page shows; other pages' study is left out. */
  listIds: string[];
  /** Words with a card over those lists. */
  learned: number;
  /** Due now over those lists. */
  due: number;
  /** The site owner: may simulate a new user's view. */
  owner?: boolean;
}) {
  const text = useIntlayer("words-stats");
  const { locale } = useLocale();
  const ui = wordsUiStore(base);
  const open = useUi(ui, (s) => s.statsOpen);
  const look = useUi(lookStore, (s) => s.look);
  const variant = useUi(variantStore, (s) => s.variant);
  const debug = useDebugOn();
  const canSim = owner || debug;
  // Days of history to pretend to have; null = the real history. Never saved.
  const [sim, setSim] = useState<number | null>(null);
  const [rows, setRows] = useState<StatsTuple[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const captionId = useId();

  useEffect(() => {
    let live = true;
    const zone = encodeURIComponent(tzName());
    fetch(`/api/words/stats?tz=${tzOffset()}&zone=${zone}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { days?: StatsTuple[] } | null) => live && setRows(d?.days ?? []))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, []);

  const ids = listIds.join(",");
  const now = new Date();
  const today = dayKey(now);
  const simOn = canSim && sim !== null;
  const shownRows = useMemo(
    () => (rows && simOn ? simulateHistory(rows, today, sim!) : rows),
    [rows, simOn, sim, today],
  );
  const days = useMemo(() => sumByDay(shownRows ?? [], new Set(ids.split(","))), [shownRows, ids]);
  const weeks = useMemo(() => gridFor(variant, days, today), [variant, days, today]);
  const grows = variant === "grow" || variant === "grow-ahead";
  const ahead = variant === "ahead" || variant === "grow-ahead";
  // B: no grid while the history is too short for one (lib/words/stats.ts tooShort).
  const noGrid = variant === "today" && rows !== null && tooShort(days);
  const firstDay = activeDays(days).find((d) => d <= today) ?? today;
  const learnedShown = simOn ? [...days.values()].reduce((n, d) => n + d.fresh, 0) : learned;
  const scale = useMemo(() => {
    const four = inkScale(days, 4);
    const five = inkScale(days, 5);
    return (d: string) => {
      const n = days.get(d)?.words ?? 0;
      return { level: four(n) as Level, strokes: five(n) };
    };
  }, [days]);
  const run = rows ? streak(days, now) : null;
  const gridDays = weeks.flat().filter((d) => d <= today);
  // A streak as long as the data read goes back further than shown: "182+".
  const runText = run === null ? null : run >= gridDays.length ? `${gridDays.length}+` : `${run}`;
  const freshToday = days.get(today)?.fresh ?? 0;
  const studied = [...days.entries()].filter(([d, v]) => v.words > 0 && d >= weeks[0][0]).length;
  const lastWeek = gridDays.slice(-WEEK);
  const vs = todayVsUsual(days, today);
  const left = WEEK - activeDays(days).length;
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const pctText =
    vs.ratio === null
      ? text.progressFirst.value
      : fill(text.progressPct.value, { pct: pct.format(vs.ratio) });
  // A grid shorter than the full span keeps the full grid's cell size.
  const narrow = weeks.length < STATS_WEEKS;
  const gridWidth = narrow
    ? { width: `calc((100% + 2px) * ${weeks.length} / ${STATS_WEEKS} - 2px)` }
    : undefined;

  const summary = [
    runText !== null ? fill(text.summaryStreak.value, { n: runText }) : null,
    rows ? fill(text.summaryToday.value, { n: freshToday }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const shown = picked ?? today;
  const shownN = days.get(shown)?.words ?? 0;
  const caption = fill(
    shownN === 0 ? text.dayNone.value : shownN === 1 ? text.dayOne.value : text.dayWords.value,
    { date: longDate(`${shown}T12:00:00`, locale), n: shownN },
  );

  return (
    <section
      data-words-stats
      data-look={look}
      className="lk-stats rounded-xl border border-[oklch(0.5_0_0/0.14)] bg-[oklch(from_var(--background)_l_c_h/0.55)]"
    >
      <button
        type="button"
        aria-expanded={open}
        title={open ? text.hide.value : text.show.value}
        onClick={() => ui.setState({ statsOpen: !open })}
        className="flex w-full min-h-11 items-center gap-2 px-3 py-2 text-left"
      >
        {/* His first day has no usual day to measure against: no bar then. */}
        {noGrid && vs.usual !== null ? (
          <span className="block w-[4.375rem] shrink-0" aria-hidden>
            <Progress look={look} today={vs.today} usual={vs.usual} />
          </span>
        ) : (
          <span className="flex shrink-0 gap-px" aria-hidden>
            {lastWeek.map((d) => (
              <span key={d} className="block w-2.5">
                <Cell look={look} day={d} {...scale(d)} today={false} />
              </span>
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
          <span className="sr-only">{text.heading}: </span>
          <span className="opacity-70 tabular-nums">{summary}</span>
        </span>
        <Icon
          name="caretRight"
          className={`shrink-0 opacity-60 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      </button>

      {open && (
        <div className="space-y-3 px-3 pb-3">
          <dl className="grid grid-cols-4 gap-2 text-center">
            {(
              [
                [learnedShown, text.learned.value],
                [freshToday, text.today.value],
                [due, text.due.value],
                [runText ?? "–", text.streak.value],
              ] as const
            ).map(([n, label]) => (
              <div key={label} className="min-w-0">
                <dd className="text-xl font-semibold tabular-nums leading-tight">{n}</dd>
                <dt className="fs-11 leading-tight opacity-60">{label}</dt>
              </div>
            ))}
          </dl>

          <Chips
            label={text.styleLabel.value}
            value={look}
            options={LOOKS.map((l) => ({
              id: l,
              name: {
                seal: text.styleSeal,
                tally: text.styleTally,
                ink: text.styleInk,
                slip: text.styleSlip,
              }[l],
            }))}
            onPick={(l) => lookStore.setState({ look: l })}
            attr="data-look-option"
          />
          <Chips
            label={text.variantLabel.value}
            value={variant}
            options={VARIANTS.map((v) => ({
              id: v,
              name: {
                full: text.variantFull,
                grow: text.variantGrow,
                today: text.variantToday,
                ahead: text.variantAhead,
                "grow-ahead": text.variantGrowAhead,
              }[v],
            }))}
            onPick={(v) => variantStore.setState({ variant: v })}
            attr="data-variant-option"
          />
          {canSim && (
            <Chips
              label={text.simLabel.value}
              value={sim === null ? "off" : String(sim)}
              options={[
                { id: "off", name: text.simOff },
                ...SIM_DAYS.map((n) => ({ id: String(n), name: fill(text.simDays.value, { n }) })),
              ]}
              onPick={(v) => setSim(v === "off" ? null : Number(v))}
              attr="data-sim-option"
            />
          )}

          {noGrid ? (
            <div className="space-y-1.5 fs-11" data-stats-progress>
              <div className="flex items-baseline justify-between gap-2 tabular-nums">
                <span className="text-[0.8125rem] font-medium">
                  {fill(text.progressToday.value, { n: vs.today })}
                </span>
                {vs.usual !== null && (
                  <span className="opacity-60">
                    {fill(text.progressUsual.value, { n: Math.round(vs.usual) })}
                  </span>
                )}
              </div>
              {vs.ratio !== null && (
                <div
                  role="progressbar"
                  aria-label={pctText}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(vs.ratio * 100)}
                >
                  <Progress look={look} today={vs.today} usual={vs.usual} />
                </div>
              )}
              <p className="opacity-70 tabular-nums">{pctText}</p>
              <p className="opacity-50">
                {left === 1 ? text.gridSoonOne : fill(text.gridSoon.value, { n: left })}
              </p>
            </div>
          ) : (
            <div>
              <p className="fs-11 opacity-50 mb-1">
                {grows && narrow
                  ? fill(text.rangeSince.value, { date: longDate(`${firstDay}T12:00:00`, locale) })
                  : text.range}
              </p>
              <div style={gridWidth}>
                <Months weeks={weeks} locale={locale} room={narrow} />
                {/* One tab stop: arrows move the picked day (←→ a week, ↑↓ a day),
                Home/End jump to the first day and today; the caption says it. */}
                <div
                  role="group"
                  tabIndex={0}
                  aria-label={
                    grows && narrow
                      ? fill(text.gridLabelSince.value, {
                          date: longDate(`${firstDay}T12:00:00`, locale),
                          n: studied,
                        })
                      : fill(text.gridLabel.value, { n: studied })
                  }
                  aria-describedby={captionId}
                  className={`flex rounded-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-[oklch(0.6_0.12_250)] ${look === "slip" ? "gap-[3px]" : "gap-[2px]"}`}
                  onClick={(e) => {
                    const d = (e.target as HTMLElement).closest<HTMLElement>("[data-day]")?.dataset
                      .day;
                    if (d) setPicked(d === picked ? null : d);
                  }}
                  onKeyDown={(e) => {
                    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
                    let next: string | null = null;
                    if (step) next = shiftDay(shown, step);
                    else if (e.key === "Home") next = gridDays[0];
                    else if (e.key === "End") next = today;
                    if (!next) return;
                    e.preventDefault();
                    if (next < gridDays[0]) next = gridDays[0];
                    if (next > today) next = today;
                    setPicked(next === today ? null : next);
                  }}
                >
                  {weeks.map((col, w) => (
                    <div
                      key={w}
                      className={`flex min-w-0 flex-1 flex-col ${look === "slip" ? "lk-slip-strip gap-0 rounded-[2px] py-[1px]" : "gap-[2px]"} ${look === "slip" && col[0] > today ? "opacity-40" : ""}`}
                    >
                      {col.map((d) =>
                        d <= today ? (
                          <div key={d} data-day={d} className="cursor-pointer">
                            <Cell
                              look={look}
                              day={d}
                              {...scale(d)}
                              today={d === today}
                              picked={d === picked}
                            />
                          </div>
                        ) : ahead ? (
                          <div key={d} data-future={d}>
                            <Future />
                          </div>
                        ) : (
                          <div key={d} className="aspect-square" />
                        ),
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2 fs-11">
                <span
                  id={captionId}
                  className="min-w-0 flex-1 truncate opacity-70 tabular-nums"
                  aria-live="polite"
                >
                  {caption}
                </span>
                <span className="opacity-50">{text.less}</span>
                <span className="flex gap-[2px]" aria-hidden>
                  {([1, 2, 3, 4] as Level[]).map((l) => (
                    <span
                      key={l}
                      className={`block w-3 ${look === "slip" ? "lk-slip-strip rounded-[2px]" : ""}`}
                    >
                      <Cell
                        look={look}
                        day={`legend-${l}`}
                        level={l}
                        strokes={[0, 1, 3, 4, 5][l]}
                        today={false}
                      />
                    </span>
                  ))}
                </span>
                <span className="opacity-50">{text.more}</span>
              </div>
              {ahead && (
                <p className="mt-1 fs-11 opacity-50">
                  {fill(text.rangeAhead.value, {
                    date: longDate(`${weeks.at(-1)!.at(-1)}T12:00:00`, locale),
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Month names over the grid, at the week a month starts in. */
function Months({
  weeks,
  locale,
  room = false,
}: {
  weeks: string[][];
  locale: string;
  /** The grid is narrower than the panel: the last column's label has room. */
  room?: boolean;
}) {
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);
  let last = "";
  return (
    <div className="flex gap-[2px] fs-11 opacity-50 mb-0.5" aria-hidden>
      {weeks.map((col, w) => {
        const first = col[0];
        const month = first.slice(0, 7);
        const label =
          month !== last && (room || w < weeks.length - 1)
            ? fmt.format(new Date(`${first}T12:00:00`))
            : "";
        last = month;
        // The first column's month only when it starts there, so two labels never touch.
        const show = label && (room || w > 0 || Number(first.slice(8)) <= 7);
        return (
          <div key={w} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
            {show ? label : ""}
          </div>
        );
      })}
    </div>
  );
}

/** A row of pill options, one picked (the look, layout and simulate switchers). */
function Chips<T extends string>({
  label,
  value,
  options,
  onPick,
  attr,
}: {
  label: string;
  value: T;
  options: { id: T; name: ReactNode }[];
  onPick: (id: T) => void;
  /** Data attribute naming each option, for QA. */
  attr: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 fs-11" role="radiogroup" aria-label={label}>
      <span className="opacity-60 me-1">{label}</span>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          {...{ [attr]: o.id }}
          onClick={() => onPick(o.id)}
          className={`min-h-8 rounded-full px-2.5 ${o.id === value ? "bg-[oklch(0.5_0_0/0.2)] font-medium" : "bg-[oklch(0.5_0_0/0.08)]"}`}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

/**
 * Today against his usual day, as a bar in the look's ink: the bar's length
 * is the larger of the two, the fill today, the tick his usual day.
 */
function Progress({ look, today, usual }: { look: Look; today: number; usual: number | null }) {
  const top = Math.max(today, usual ?? 0, 1);
  return (
    <span className="lk-progress relative block h-2 rounded-full" data-look={look}>
      <span
        className="lk-progress-fill absolute inset-y-0 start-0 rounded-full"
        style={{ width: `${(100 * today) / top}%` }}
      />
      {usual !== null && (
        <span
          className="lk-progress-usual absolute -inset-y-0.5 w-0.5 rounded-full"
          style={{ insetInlineStart: `calc(${(100 * usual) / top}% - 1px)` }}
        />
      )}
    </span>
  );
}

/** A day still to come (the "ahead" layouts): a faint dashed frame. */
function Future() {
  return (
    <svg viewBox="0 0 10 10" className="block aspect-square w-full" aria-hidden>
      <rect
        x={1.2}
        y={1.2}
        width={7.6}
        height={7.6}
        rx={1.4}
        fill="none"
        strokeWidth={0.6}
        strokeDasharray="1.4 1"
        className="lk-ink-future"
      />
    </svg>
  );
}

/** Strokes of 正 in writing order, on a 10×10 box. */
const TALLY = ["M2 1.8H8", "M5 1.8V8.6", "M5 5.1H7.6", "M2.6 5.1V8.6", "M1.2 8.6H8.8"];
const SEAL_SIZE = [0, 6.4, 7.6, 8.6, 9.6];
const SEAL_ALPHA = [0, 0.5, 0.7, 0.86, 1];
const INK_R = [0, 1.9, 2.7, 3.5, 4.6];
const INK_ALPHA = [0, 0.4, 0.58, 0.76, 0.94];
const NOTCH = [0, 0.38, 0.56, 0.74, 0.92];

/** One day, drawn in the chosen look. `level` 0 = not studied. */
export function Cell({
  look,
  day,
  level,
  strokes = level,
  today,
  picked = false,
}: {
  look: Look;
  day: string;
  level: Level;
  /** Strokes of 正 written, 0–5 (the tally look). */
  strokes?: number;
  today: boolean;
  picked?: boolean;
}) {
  const ring = today || picked;
  return (
    <svg
      viewBox="0 0 10 10"
      className="block aspect-square w-full overflow-visible"
      aria-hidden
      data-level={level}
    >
      {look === "seal" &&
        (level ? (
          <g transform={`rotate(${sealTilt(day)} 5 5)`} opacity={SEAL_ALPHA[level]}>
            <rect
              x={5 - SEAL_SIZE[level] / 2}
              y={5 - SEAL_SIZE[level] / 2}
              width={SEAL_SIZE[level]}
              height={SEAL_SIZE[level]}
              rx={1.1}
              className="lk-ink-seal"
            />
            {level >= 3 && (
              <rect
                x={5 - SEAL_SIZE[level] / 2 + 1.3}
                y={5 - SEAL_SIZE[level] / 2 + 1.3}
                width={SEAL_SIZE[level] - 2.6}
                height={SEAL_SIZE[level] - 2.6}
                rx={0.5}
                fill="none"
                strokeWidth={0.7}
                className="lk-ink-carve"
              />
            )}
          </g>
        ) : (
          <rect x={1} y={1} width={8} height={8} rx={1.4} className="lk-ink-blank" />
        ))}
      {look === "tally" &&
        (level ? (
          TALLY.map((d, i) => (
            <path
              key={i}
              d={d}
              strokeWidth={1.25}
              strokeLinecap="round"
              fill="none"
              className={i < strokes ? "lk-ink-brush" : "lk-ink-ghost"}
            />
          ))
        ) : (
          <circle cx={5} cy={5} r={0.9} className="lk-ink-dot" />
        ))}
      {look === "ink" &&
        (level ? (
          <circle
            cx={5}
            cy={5}
            r={INK_R[level]}
            opacity={INK_ALPHA[level]}
            className="lk-ink-wash"
          />
        ) : (
          <circle cx={5} cy={5} r={0.9} className="lk-ink-dot" />
        ))}
      {look === "slip" && level > 0 && (
        <rect
          x={5 - (NOTCH[level] * 10) / 2}
          y={4.1}
          width={NOTCH[level] * 10}
          height={1.8}
          rx={0.9}
          className="lk-ink-notch"
        />
      )}
      {ring && (
        <rect
          x={0.3}
          y={0.3}
          width={9.4}
          height={9.4}
          rx={1.6}
          fill="none"
          strokeWidth={0.8}
          className={picked ? "lk-ink-picked" : "lk-ink-today"}
        />
      )}
    </svg>
  );
}
