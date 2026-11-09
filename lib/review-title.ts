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
