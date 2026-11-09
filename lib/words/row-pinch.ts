/**
 * Pinch for card height on /words (owner, 2026-11-10): a two-finger vertical
 * pinch over the list makes every row shorter and denser (pinch in) or taller,
 * with more of each card shown (pinch out). Flag `words.pinch-card-height`.
 *
 * The height is continuous while the fingers move and settles on a whole
 * number of back lines when they lift. Its bounds come from the cards, not
 * from fixed numbers: the shortest row is the word alone; the tallest shows
 * everything the rows on screen hold (their measured lines, `linesToShow`).
 *
 * Stored as a factor of the row's default height (`rowMetrics`), synced as
 * `words.cardHeight` (docs/prefs-sync.md): the same factor on a phone and on
 * a desk, at any text size. 1 = the default, which changes nothing.
 *
 * Pure: the page measures and moves the list (app/(app)/words/WordsClient.tsx).
 */
import { ROW_LINE_LH, ROW_LINE_PX } from "@/lib/words/row-layout";

/** The localStorage key (a plain binding of lib/prefs/bindings.ts). */
export const CARD_HEIGHT_KEY = "lk:words-card-height";
/** The schema's sanity range for the stored factor (not a user-facing bound). */
export const CARD_HEIGHT_RANGE = [0.1, 10] as const;

/**
 * A row's vertical padding around its text, px at text scale 1. Read off the
 * default rows: 66px on touch holds three back lines (two of the example, one
 * of the meaning), 42px on a desk two per column (lib/words/row-layout.ts).
 */
const PAD_PX = { touch: 12, desktop: 6 } as const;
/** The word's own line: text-base on touch, 15px on a desk, at ROW_LINE_LH. */
const WORD_LINE_PX = { touch: 16 * ROW_LINE_LH, desktop: 15 * ROW_LINE_LH } as const;
/** Rounding slack when a stored factor is turned back into a whole-px row. */
const SLACK_PX = 1;
/** No row is laid out with more back lines than this (a guard, never reached by text). */
export const LINES_CAP = 40;

const kind = (touch: boolean) => (touch ? "touch" : "desktop");

/**
 * The height that shows `n` lines of back text, px at text scale `k`. Level 0
 * is the word alone, a little tighter than a one-line row; from one line up,
 * the back text sits beside the word, so a row is never shorter than the word.
 */
export function levelHeight(n: number, k: number, touch: boolean): number {
  const t = kind(touch);
  const pad = PAD_PX[t];
  const word = WORD_LINE_PX[t];
  const s = Math.max(1, k);
  if (n <= 0) return (word + pad / 2) * s;
  return (pad + Math.max(word, n * ROW_LINE_PX)) * s;
}

/** How many lines of back text a row of `rowH` px has room for (0: the word alone). */
export function backAvail(rowH: number, k: number, touch: boolean): number {
  let n = 0;
  while (n < LINES_CAP && levelHeight(n + 1, k, touch) <= rowH + SLACK_PX) n++;
  return n;
}

/**
 * The line clamps of a row's back cells for `avail` lines. Desktop: the
 * columns stand side by side, each gets them all. Touch: the cells stack;
 * the meaning (second) keeps one line and the example (first) takes the rest,
 * as the default rows do, and lines beyond the default's three are shared
 * out, the first taking the odd one. 0 = the cell is not shown.
 */
export function backLines(avail: number, touch: boolean): { first: number; second: number } {
  const n = Math.max(0, Math.floor(avail));
  if (!touch) return { first: n, second: n };
  if (n <= 1) return { first: n, second: 0 };
  const base = 3;
  if (n <= base) return { first: n - 1, second: 1 };
  const extra = n - base;
  return { first: 2 + Math.ceil(extra / 2), second: 1 + Math.floor(extra / 2) };
}

/** What a row's back cells need to be shown in full, in lines (measured on the page). */
export interface RowNeed {
  first: number;
  second: number;
}

/** The fewest back lines that show this row's cells in full under `backLines`. */
export function linesToShow(need: RowNeed, touch: boolean): number {
  const f = Math.max(0, Math.ceil(need.first));
  const s = Math.max(0, Math.ceil(need.second));
  if (!touch) return Math.min(LINES_CAP, Math.max(f, s));
  for (let n = 0; n <= LINES_CAP; n++) {
    const l = backLines(n, true);
    if (l.first >= f && (s === 0 || l.second >= s)) return n;
  }
  return LINES_CAP;
}

/** The height bounds a pinch moves within, from the rows on screen. */
export function pinchBounds(
  needs: readonly RowNeed[],
  k: number,
  touch: boolean,
  current: number,
): { min: number; max: number } {
  const most = needs.reduce((m, n) => Math.max(m, linesToShow(n, touch)), 0);
  // Never a jump at the start: the row as it is lies within the bounds.
  return {
    min: Math.min(current, levelHeight(0, k, touch)),
    max: Math.max(current, levelHeight(most, k, touch)),
  };
}

/**
 * The vertical distance of two touches, never below `floor` px: fingers side
 * by side would otherwise make a tiny move a huge change.
 */
export function verticalSpan(ys: readonly [number, number], floor: number): number {
  return Math.max(floor, Math.abs(ys[0] - ys[1]));
}

/** The row height during a pinch: the start height times the fingers' spread, within bounds. */
export function pinchHeight(
  startH: number,
  startSpan: number,
  span: number,
  bounds: { min: number; max: number },
): number {
  const r = startSpan > 0 && span > 0 ? span / startSpan : 1;
  return Math.min(bounds.max, Math.max(bounds.min, startH * r));
}

/**
 * Where a pinch settles: the nearest whole level within bounds. The default's
 * own level settles on the default height exactly, so a pinch back home is
 * factor 1 again.
 */
export function settleHeight(
  h: number,
  k: number,
  touch: boolean,
  defaultH: number,
  bounds: { min: number; max: number },
): number {
  const home = backAvail(defaultH, k, touch);
  let best = h;
  let gap = Infinity;
  for (let n = 0; n <= LINES_CAP; n++) {
    const at = n === home ? defaultH : levelHeight(n, k, touch);
    if (at > bounds.max + SLACK_PX && n > 0) break;
    if (at < bounds.min - SLACK_PX) continue;
    const d = Math.abs(at - h);
    if (d < gap) {
      gap = d;
      best = at;
    }
  }
  return best;
}

/** The factor stored for a row height (3 decimals, within the schema's range). */
export function toFactor(h: number, defaultH: number): number {
  const f = defaultH > 0 ? h / defaultH : 1;
  const [lo, hi] = CARD_HEIGHT_RANGE;
  return Math.round(Math.min(hi, Math.max(lo, f)) * 1000) / 1000;
}

/** A stored factor, or 1 when it is not one. */
export function asFactor(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  const [lo, hi] = CARD_HEIGHT_RANGE;
  return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi ? n : 1;
}

/** The row height for a factor; the default's own height when the factor is 1. */
export function rowHeightFor(defaultH: number, factor: number): number {
  return factor === 1 ? defaultH : Math.max(1, Math.round(defaultH * factor));
}

/** The minimum-jerk curve the settle follows (lib/words: MIN_JERK in CSS). */
export function minJerk(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (10 - 15 * x + 6 * x * x);
}
