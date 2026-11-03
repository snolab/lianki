"use client";

/**
 * The /words list picker's stats strip: folded, one line (the last week's
 * cells, streak, new today; due is on Study all just below); open, four headline counts and a six-month
 * study heatmap, one cell per local day. The heatmap's look is switchable
 * (seals, 正 tallies, ink dots, bamboo slips) while the owner compares them;
 * the choice is this device's (`lk:pref:words-stats-look`).
 *
 * Data: the counts already on the lists (cards, due) plus one GET
 * /api/words/stats when the picker opens. Nothing polls.
 */
import { useEffect, useMemo, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { createUiStore, useUi } from "@lianki/ui-state";
import { Icon } from "@/app/components/icons";
import { fill } from "@/lib/nav/nav-core";
import { longDate } from "@/lib/dates";
import {
  dayKey,
  gridWeeks,
  inkScale,
  sealTilt,
  streak,
  sumByDay,
  tzOffset,
  type StatsTuple,
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

type Level = 0 | 1 | 2 | 3 | 4;

export default function WordsStats({
  base,
  listIds,
  learned,
  due,
}: {
  /** The page (/words, /alphabets): its own folded/open state. */
  base: string;
  /** The lists this page shows; other pages' study is left out. */
  listIds: string[];
  /** Words with a card over those lists. */
  learned: number;
  /** Due now over those lists. */
  due: number;
}) {
  const text = useIntlayer("words-stats");
  const { locale } = useLocale();
  const ui = wordsUiStore(base);
  const open = useUi(ui, (s) => s.statsOpen);
  const look = useUi(lookStore, (s) => s.look);
  const [rows, setRows] = useState<StatsTuple[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/words/stats?tz=${tzOffset()}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { days?: StatsTuple[] } | null) => live && setRows(d?.days ?? []))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, []);

  const ids = listIds.join(",");
  const days = useMemo(() => sumByDay(rows ?? [], new Set(ids.split(","))), [rows, ids]);
  const now = new Date();
  const today = dayKey(now);
  const weeks = useMemo(() => gridWeeks(new Date(`${today}T12:00:00`)), [today]);
  const scale = useMemo(() => {
    const four = inkScale(days, 4);
    const five = inkScale(days, 5);
    return (d: string) => {
      const n = days.get(d)?.words ?? 0;
      return { level: four(n) as Level, strokes: five(n) };
    };
  }, [days]);
  const run = rows ? streak(days, now) : null;
  const freshToday = days.get(today)?.fresh ?? 0;
  const studied = [...days.entries()].filter(([d, v]) => v.words > 0 && d >= weeks[0][0]!).length;
  const lastWeek = weeks
    .flat()
    .filter((d): d is string => !!d)
    .slice(-7);

  const summary = [
    run !== null ? fill(text.summaryStreak.value, { n: run }) : null,
    fill(text.summaryToday.value, { n: freshToday }),
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
        <span className="flex shrink-0 gap-px" aria-hidden>
          {lastWeek.map((d) => (
            <span key={d} className="block w-2.5">
              <Cell look={look} day={d} {...scale(d)} today={false} />
            </span>
          ))}
        </span>
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
                [learned, text.learned.value],
                [freshToday, text.today.value],
                [due, text.due.value],
                [run ?? "–", text.streak.value],
              ] as const
            ).map(([n, label]) => (
              <div key={label} className="min-w-0">
                <dd className="text-xl font-semibold tabular-nums leading-tight">{n}</dd>
                <dt className="fs-11 leading-tight opacity-60">{label}</dt>
              </div>
            ))}
          </dl>

          <div
            className="flex flex-wrap items-center gap-1.5 fs-11"
            role="radiogroup"
            aria-label={text.styleLabel.value}
          >
            <span className="opacity-60 me-1">{text.styleLabel}</span>
            {LOOKS.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={l === look}
                data-look-option={l}
                onClick={() => lookStore.setState({ look: l })}
                className={`min-h-8 rounded-full px-2.5 ${l === look ? "bg-[oklch(0.5_0_0/0.2)] font-medium" : "bg-[oklch(0.5_0_0/0.08)]"}`}
              >
                {
                  {
                    seal: text.styleSeal,
                    tally: text.styleTally,
                    ink: text.styleInk,
                    slip: text.styleSlip,
                  }[l]
                }
              </button>
            ))}
          </div>

          <div>
            <p className="fs-11 opacity-50 mb-1">{text.range}</p>
            <Months weeks={weeks} locale={locale} />
            <div
              role="img"
              aria-label={fill(text.gridLabel.value, { n: studied })}
              className={`flex ${look === "slip" ? "gap-[3px]" : "gap-[2px]"}`}
              onClick={(e) => {
                const d = (e.target as HTMLElement).closest<HTMLElement>("[data-day]")?.dataset.day;
                if (d) setPicked(d === picked ? null : d);
              }}
            >
              {weeks.map((col, w) => (
                <div
                  key={w}
                  className={`flex min-w-0 flex-1 flex-col ${look === "slip" ? "lk-slip-strip gap-0 rounded-[2px] py-[1px]" : "gap-[2px]"}`}
                >
                  {col.map((d, i) =>
                    d ? (
                      <div key={d} data-day={d} className="cursor-pointer">
                        <Cell
                          look={look}
                          day={d}
                          {...scale(d)}
                          today={d === today}
                          picked={d === picked}
                        />
                      </div>
                    ) : (
                      <div key={i} className="aspect-square" />
                    ),
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 fs-11">
              <span className="min-w-0 flex-1 truncate opacity-70 tabular-nums" aria-live="polite">
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
          </div>
        </div>
      )}
    </section>
  );
}

/** Month names over the grid, at the week a month starts in. */
function Months({ weeks, locale }: { weeks: (string | null)[][]; locale: string }) {
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);
  let last = "";
  return (
    <div className="flex gap-[2px] fs-11 opacity-50 mb-0.5" aria-hidden>
      {weeks.map((col, w) => {
        const first = col.find(Boolean)!;
        const month = first.slice(0, 7);
        const label =
          month !== last && w < weeks.length - 1 ? fmt.format(new Date(`${first}T12:00:00`)) : "";
        last = month;
        // The first column's month only when it starts there, so two labels never touch.
        const show = label && (w > 0 || first.endsWith("-01") || Number(first.slice(8)) <= 7);
        return (
          <div key={w} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
            {show ? label : ""}
          </div>
        );
      })}
    </div>
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
