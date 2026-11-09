/**
 * A /words row's answer side, in the order it is shown and read aloud.
 *
 * Owner, 2026-11-03 19:31 JST: "所有的卡组改成例句优先——第二列用来显示例句，
 * 第三列才用来显示意思". Every deck, every language: the word, then its example
 * sentence, then its meaning (19:47 JST: only these two swap places; the
 * layout stays). One order, as data: the row's columns, the phone's two back
 * lines and what a tap reads (lib/words/say-parts.ts) all follow it.
 */
export const BACK_ORDER = ["example", "meaning"] as const;
export type BackPart = (typeof BACK_ORDER)[number];

/** What a card's back can hold: an example sentence (or a phrase's note in its place) and a meaning. */
export interface BackCard {
  ex?: string;
  note?: string;
}

/**
 * The back parts a card has, in BACK_ORDER. A card with no example (and no
 * phrase note) has only its meaning, which then takes the example's place:
 * no empty column, no empty line.
 */
export function backParts(it: BackCard): BackPart[] {
  return BACK_ORDER.filter((k) => k === "meaning" || !!(it.ex || it.note));
}

/**
 * How much taller a row is than its swipe unit. Owner, 2026-11-03 23:01 JST:
 * "单词列表复习的时候，卡片的高度再拉高那么一点… 1.5倍高度吧，现在的1.5倍".
 * Same layout and columns (the 3× slips were rejected, words-session-spec.md);
 * the height goes to the text: the first back line may wrap to a second line.
 */
export const ROW_TALL = 1.5;
/** The base unit before ROW_TALL: the 44px touch target, the 28px desktop line. */
const BASE_PX = { touch: 44, desktop: 28 } as const;
/** Line height of a /words cell that wraps (Glance `lines`), in em. */
export const ROW_LINE_LH = 1.25;
/** One line of a row's back text (text-sm, 14px, at ROW_LINE_LH), in px at text scale 1. */
export const ROW_LINE_PX = 14 * ROW_LINE_LH;

/**
 * A /words row's sizes for a card text scale (lib/text-size.ts): `rowH` is
 * what the list, the cords and the windowing use; `a` is the swipe's travel
 * unit (one detent), which stays the old row height so a grade still takes
 * the same finger distance. Both grow with the text, never shrink.
 *
 * `extraLines`: lines of back text added to every row, each one line of its
 * own text (ROW_LINE_PX), not a fixed step. The reader's word review takes
 * one (owner, 2026-11-08 19:16 JST, on /read: "increase the height of every
 * card by one more line"); the swipe unit stays.
 */
export function rowMetrics(
  touch: boolean,
  cardScale: number,
  extraLines = 0,
): { rowH: number; a: number } {
  const k = Math.max(1, cardScale);
  const base = touch ? BASE_PX.touch : BASE_PX.desktop;
  const n = Math.max(0, extraLines);
  return { rowH: Math.round((base * ROW_TALL + n * ROW_LINE_PX) * k), a: Math.round(base * k) };
}
