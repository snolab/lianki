/**
 * The study view's way back at the end of the list (owner, 2026-11-05
 * 02:00–02:04 JST: "都学完了的情况也是显示返回按钮", and the "no more cards"
 * picture itself as the back action). The empty tray after the last word is a
 * button doing what the toolbar's exit does, with the same label under it —
 * back to the lists on /words, back to the book in the reader's paragraph
 * review (its scope's `exitLabel`, which closes the overlay and focuses the
 * paragraph again). It sits there in every state — not started, half way, all
 * done — and stands alone when there is nothing to list at all.
 */
import { TrayArt } from "./EmptyTray";

/** Nothing left to grade: no more to fetch and every word from the cursor on graded. */
export const studyFinished = (exhausted: boolean, aheadLeft: number) =>
  exhausted && aheadLeft === 0;

/**
 * The grade just given finished the review, so focus moves to the way back
 * (owner, 2026-11-05 13:37 JST: after the last card, Enter goes back to the
 * book instead of focus falling off). Only when the card was
 * - graded for the first time in this session (`first`): re-rating an earlier
 *   card is a correction (#511), which moves the cursor with the view still;
 * - one to review (`reviewable`: new, or due by now): browsing a word ahead
 *   of its due never ends anything;
 * and nothing is left: no more to fetch (`exhausted`), no other new or due
 * word ungraded in the list (`left`), and no missed word waiting to come
 * back (`waiting`: #536's copies, off screen or not yet due, are still to
 * answer).
 */
export function reviewEnded(o: {
  first: boolean;
  reviewable: boolean;
  exhausted: boolean;
  left: number;
  waiting: number;
}): boolean {
  return o.first && o.reviewable && o.exhausted && o.left === 0 && o.waiting === 0;
}

/**
 * The tray as a button. Needs a `.lk-tray` ancestor for the picture's colours.
 * `art: false` (a short over-scroll) keeps just the label, still 44px tall.
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
      className="pointer-events-auto flex min-h-11 min-w-11 flex-col items-center justify-center gap-1 rounded-2xl px-4 py-2 text-sm font-medium text-[oklch(0.45_0.02_260)] outline-none hover:bg-[oklch(0.5_0_0/0.08)] focus-visible:ring-2 focus-visible:ring-[oklch(0.6_0.12_250)] active:bg-[oklch(0.5_0_0/0.12)] dark:text-[oklch(0.8_0.01_260)]"
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
