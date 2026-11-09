/**
 * The study view's way back at the end of the list (owner, 2026-11-05
 * 02:00–02:04 JST: "都学完了的情况也是显示返回按钮", and the "no more cards"
 * picture itself as the back action). The empty tray after the last word is a
 * button doing what the toolbar's exit does, with the same label under it —
 * back to the lists on /words, back to the book in the reader's paragraph
 * review (its scope's `exitLabel`, which closes the overlay and focuses the
 * paragraph again). It sits there in every state — not started, half way, all
 * done — and stands alone when there is nothing to list at all. Once the list
 * is done, G presses it as well as Enter on it (owner, 2026-11-06).
 */
import { TrayArt } from "./EmptyTray";

/** Nothing left to grade: no more to fetch and every word from the cursor on graded. */
export const studyFinished = (exhausted: boolean, aheadLeft: number) =>
  exhausted && aheadLeft === 0;

/**
 * Nothing is left to do in the list: no more to fetch (`exhausted`), no other
 * word to review ungraded (`left`), no fetched word about to join (`waiting`).
 * A missed word's own copy (#536) does not count as waiting: on a short list
 * it can only join once the tail has left the screen, so it would hold the end
 * back for good (owner, 2026-11-07: "review last word in list should focus
 * into return btn", whatever the grade).
 */
export const listDone = (o: { exhausted: boolean; left: number; waiting: number }) =>
  o.exhausted && o.left === 0 && o.waiting === 0;

/**
 * The grade just given finished the review, so focus moves to the way back
 * (owner, 2026-11-05 13:37 JST: after the last card, Enter goes back to the
 * book instead of focus falling off). Only when the card was
 * - graded for the first time in this session (`first`): re-rating an earlier
 *   card is a correction (#511), which moves the cursor with the view still;
 * - one to review (`reviewable`): on /words a word browsed ahead of its due
 *   never ends anything; in a scoped review every row is one;
 * and the list is done (`listDone`).
 */
export function reviewEnded(o: {
  first: boolean;
  reviewable: boolean;
  exhausted: boolean;
  left: number;
  waiting: number;
}): boolean {
  return o.first && o.reviewable && listDone(o);
}

/**
 * The cue may take the focus: not when it has moved on to something real since
 * the grade (the chat input, a link). `body` is nothing: a row that held the
 * focus scrolled out of the window, or a tap landed on no control.
 */
export const focusStillFree = (
  active: Element | null,
  from: Element | null,
  body: Element | null,
) => active === from || active === null || active === body;

/** The key goes to a field being typed in: the study keys stay out of it. */
export const inTypingField = (t: Pick<HTMLElement, "tagName"> & { isContentEditable?: boolean }) =>
  t.tagName === "INPUT" ||
  t.tagName === "TEXTAREA" ||
  t.tagName === "SELECT" ||
  !!t.isContentEditable;

/**
 * The tray as a button. Needs a `.lk-tray` ancestor for the picture's colours.
 * `art: false` (a short over-scroll) keeps just the label, still 44px tall.
 * The focused look is `:focus`, not `:focus-visible`: focus arrives from a swipe
 * too, where a browser may not count it as visible (owner, 2026-11-06: "when
 * focusing in 返回書本 we should show as focused"). A pointer press leaves the
 * page, so it never lingers on one.
 */
export function TrayBack({
  label,
  onExit,
  art,
}: {
  label: string;
  onExit: () => void;
  art: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onExit}
      data-testid="study-done-back"
      className="pointer-events-auto flex min-h-11 min-w-11 flex-col items-center justify-center gap-1 rounded-2xl px-4 py-2 text-sm font-medium text-[oklch(0.45_0.02_260)] outline-none hover:bg-[oklch(0.5_0_0/0.08)] focus:bg-[oklch(0.6_0.12_250/0.16)] focus:ring-[3px] focus:ring-[oklch(0.6_0.14_250)] active:bg-[oklch(0.5_0_0/0.12)] dark:text-[oklch(0.8_0.01_260)]"
    >
      {art && (
        // aria-hidden: the button's name is its label.
        <span aria-hidden="true" data-empty-tray className="block">
          <TrayArt />
        </span>
      )}
      <span>{label}</span>
    </button>
  );
}
