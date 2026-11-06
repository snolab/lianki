/**
 * The DOM side of ask-above.ts: which open ask cards are above the log's view.
 * One IntersectionObserver rooted at the log, on the open cards only. It reports
 * when a card crosses the edge, so a scroll costs nothing in between: no polling,
 * no scroll listener, no timer. The first report on each card comes by itself.
 *
 * The observed region runs from the view's top edge down past the end of any
 * history, so its one edge in play is the top: a card reports whenever it crosses
 * that. With the plain view as the region, a jump from far up to the end takes a
 * card from below the view to above it within one frame, never intersecting, and
 * the observer stays silent.
 */
import { ABOVE_INSET_PX, isAbove } from "./ask-above";

const LINE = '[data-testid="debug-chat-line"]';
const CARD = '[data-testid="debug-chat-ask"]';
/** Below the view, the region goes on this far: past the end of any history. */
const BELOW_PX = 10_000_000;

/** A line in the log by its message id. */
export const lineIn = (log: Element, id: string) =>
  [...log.querySelectorAll<HTMLElement>(LINE)].find((l) => l.dataset.msg === id) ?? null;

/** Watches the cards of the lines `ids`; `onChange` gets the ids above the view. */
export function watchAsksAbove(
  log: Element,
  ids: readonly string[],
  onChange: (above: ReadonlySet<string>) => void,
): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  const idOf = new Map<Element, string>();
  for (const id of ids) {
    const card = lineIn(log, id)?.querySelector(CARD);
    if (card) idOf.set(card, id);
  }
  const above = new Set<string>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = idOf.get(e.target);
        if (id === undefined) continue;
        const up = isAbove({
          isIntersecting: e.isIntersecting,
          bottom: e.boundingClientRect.bottom,
          rootTop: e.rootBounds?.top ?? 0,
        });
        if (up) above.add(id);
        else above.delete(id);
      }
      onChange(new Set(above));
    },
    { root: log, rootMargin: `-${ABOVE_INSET_PX}px 0px ${BELOW_PX}px 0px` },
  );
  for (const card of idOf.keys()) io.observe(card);
  return () => io.disconnect();
}
