"use client";

/**
 * Island `words.swipeGrades` (docs/swipe-core.md): what a sliding slip
 * uncovers, in a row-wide box with --a set (SwipeUnderlay and NativeSlipRow).
 * One slot per side, the width of both detents. Its first detent's grade
 * shows until the slip reaches the far detent; then the far grade takes over
 * the same spot (crossfade + a short slide, CSS .lk-reveal), and gives it
 * back on the way home. The container's data-good / data-hard (showReveal in
 * WordsClient) pick which. The grade names come as props, in the app's
 * language (words-page, read by the host). `mirror` (Settings → Mirror swipe
 * sides, lib/words/swipe.ts): Good/Easy sit on the right, uncovered by a slide
 * left, and Hard/Again on the left.
 */
type Rating = 1 | 2 | 3 | 4;

const BG: Record<Rating, string> = {
  1: "var(--slip-again)",
  2: "var(--slip-hard)",
  3: "var(--slip-good)",
  4: "var(--slip-easy)",
};
export function SwipeGrades({
  again,
  hard,
  good,
  easy,
  mirror = false,
}: {
  again: string;
  hard: string;
  good: string;
  easy: string;
  mirror?: boolean;
}) {
  const LABEL: Record<Rating, string> = { 1: again, 2: hard, 3: good, 4: easy };
  const layer = (r: Rating, side: "left" | "right", far: boolean) => (
    <span
      data-reveal={r}
      data-far={far ? "" : undefined}
      className="lk-reveal absolute inset-0"
      style={{ background: BG[r] }}
    >
      <span
        className="absolute inset-y-0 flex items-center justify-center fs-11 font-medium opacity-90"
        style={{ [side]: 0, width: "var(--a)" }}
      >
        {LABEL[r]}
      </span>
    </span>
  );
  const goodSide = mirror ? "right" : "left";
  const hardSide = mirror ? "left" : "right";
  return (
    <>
      <span
        data-reveal-slot="good"
        data-reveal-side={goodSide}
        className={`absolute inset-y-0 ${mirror ? "right-0" : "left-0"} overflow-hidden`}
        style={{ width: "calc(var(--a) * 2.5)" }}
      >
        {layer(3, goodSide, false)}
        {layer(4, goodSide, true)}
      </span>
      <span
        data-reveal-slot="hard"
        data-reveal-side={hardSide}
        className={`absolute inset-y-0 ${mirror ? "left-0" : "right-0"} overflow-hidden`}
        style={{ width: "calc(var(--a) * 2.5)" }}
      >
        {layer(2, hardSide, false)}
        {layer(1, hardSide, true)}
      </span>
    </>
  );
}
