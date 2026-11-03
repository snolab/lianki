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
