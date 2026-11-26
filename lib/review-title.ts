import { displayTitle } from "@/lib/titles/client";

/**
 * The title /review shows for a card: the current card and the next-up strip
 * both go through here, so noise cleaning reaches them in one place. Display
 * only: a stored title is never changed. Null falls back to the card's url.
 * The url is needed because most cleaning rules are per host (docs/title-clean.md).
 */
export function reviewTitle(title: string | null, url: string): string | null {
  return displayTitle(title, url);
}

/** Wide (CJK, fullwidth, emoji) code points take about two Latin letters' room. */
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** How many Latin-letter widths the text takes: wide characters count 2. */
export function titleWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

/**
 * Font scale for the current card's title (owner, 2026-11-27: "if the title is
 * too long, make the font smaller; every character must be visible"). Up to
 * `fitChars` widths it stays 1; past that the area a title needs grows with its
 * length, so the scale falls with the square root, down to `minPct`/100. Below
 * that floor the title only wraps (never clipped or ellipsised; the caller
 * wraps anywhere, so a CJK title with no spaces breaks too).
 * Defaults: review.titleFitChars / review.titleMinScalePct in lib/config.ts.
 */
export function reviewTitleScale(text: string, fitChars: number, minPct: number): number {
  const w = titleWidth(text);
  const min = Math.min(1, Math.max(0, minPct / 100));
  if (w <= fitChars || fitChars <= 0) return 1;
  const s = Math.sqrt(fitChars / w);
  // Two decimals: a stable value for the server render and the browser.
  return Math.round(Math.max(min, s) * 100) / 100;
}
