/**
 * The study view's way back when there is nothing left to grade (owner,
 * 2026-11-05 02:00 JST: "都学完了的情况也是显示返回按钮"). Every word
 * learned, or none due, is never a dead end: the done text gets a button that
 * does what the toolbar's exit does, with the same label — back to the lists
 * on /words, back to the book in the reader's paragraph review (its scope's
 * `exitLabel`, which closes the overlay and focuses the paragraph again).
 */

/** Nothing left to grade: no more to fetch and every word from the cursor on graded. */
export const studyFinished = (exhausted: boolean, aheadLeft: number) =>
  exhausted && aheadLeft === 0;

/** The extra room the button takes under the last row (pt-6 + min-h-11). */
export const DONE_BACK_H = 72;

export function StudyDoneBack({ label, onExit }: { label: string; onExit: () => void }) {
  return (
    <button
      type="button"
      onClick={onExit}
      data-testid="study-done-back"
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[oklch(0.85_0.01_260)] bg-[oklch(0.97_0.005_260)] px-5 text-sm font-medium text-[oklch(0.3_0.02_260)] hover:bg-[oklch(0.93_0.008_260)] dark:border-[oklch(0.4_0.01_260)] dark:bg-[oklch(0.25_0.01_260)] dark:text-[oklch(0.92_0.01_260)] dark:hover:bg-[oklch(0.3_0.01_260)]"
    >
      {label}
    </button>
  );
}
