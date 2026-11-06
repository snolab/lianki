/**
 * The title /review shows for a card: the current card and the next-up strip
 * both go through here, so noise cleaning reaches them in one place. Display
 * only: a stored title is never changed. Null falls back to the card's url.
 *
 * A pass-through until the shared title normalizer lands (`displayTitle` from
 * `@/lib/titles/client`); that change only needs to edit this function. The
 * url is there for it: its rules are per host.
 */
export function reviewTitle(title: string | null, _url: string): string | null {
  return title;
}
