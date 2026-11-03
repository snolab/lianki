/**
 * A /words row's answer side, in the order it is shown and read aloud.
 *
 * Owner, 2026-11-03 19:31 JST: "所有的卡组改成例句优先——第二列用来显示例句，
 * 第三列才用来显示意思". Every deck, every language: the word, then its example
 * sentence, then its meaning. One order, as data: the row's columns, the
 * phone's lines and what a tap reads (lib/words/say-parts.ts) all follow it.
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
 * Phones (owner, 19:31 JST: "移动端的话就是第二行显示例句，第三行显示解释";
 * every row, decided 19:35 JST): a narrow screen stacks each row as three
 * lines — word (with its reading), example, meaning — each cut to one line,
 * in full in the focused row's glance and the double-tap sheet. Wider
 * screens keep the columns. The switch: "all" rows, or "focused" (only the
 * focused row stacks; the rest keep the compact two-column row and its
 * height).
 */
export const PHONE_LINES: "focused" | "all" = "all";

/** Narrower than this (CSS px) a phone stacks its rows (Tailwind's sm). */
export const NARROW_PX = 640;

/** Row heights in CSS px, before the card text scale: three tight lines on a phone. */
export const ROW_PX = { touch: 44, lines: 56, desktop: 28 } as const;

/** Whether a row stacks as three lines. */
export function stacksLines(narrow: boolean, focused: boolean): boolean {
  return narrow && (PHONE_LINES === "all" || focused);
}

/** The rows' height: every row is the same height (the windowing depends on it). */
export function rowPx(touch: boolean, narrow: boolean): number {
  if (!touch) return ROW_PX.desktop;
  return narrow && PHONE_LINES === "all" ? ROW_PX.lines : ROW_PX.touch;
}
