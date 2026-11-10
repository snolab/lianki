# /words session spec (owner, 2026-11-03 02:58–03:25 JST)

What the owner asked for on /words in one evening, spoken while testing on
his phone. Written down so it is not lost. Status per item; PRs fill in as
they land. Design details that are still open are marked **open**.

## Layout

- **Tall slips: tried and REJECTED** (03:38 JST, rolled back on the dev
  server, never shipped). He first asked for one slip per word, 3 cells tall,
  holding word, meaning and examples in large type, 3–5 per screen. On his
  phone he called it ugly ("太丑，回滚"): the **left and right columns are
  gone**, so words no longer line up visually, and **each screen carries far
  too little**. Keep the two-column layout and its density. The unmerged
  branch `feat/words-big-cells` (local, tree/words-big-cells) has the attempt.
  Still open: showing the meaning and examples that the small cells cut off,
  without losing the columns.
- **Example first** (19:31 JST, every deck and language; 19:47 JST: "不改layout，
  目前需要的只是swap例句和解释的位置"): the example sentence and the meaning
  swap places, nothing else in the layout changes. Desktop: word · example ·
  meaning columns; phones: the word beside two lines, the example above the
  meaning; a tap reads word → example → meaning. The order is data
  (`BACK_ORDER`, `lib/words/row-layout.ts`), never per language. A card
  without an example shows its meaning where the example would be (desktop:
  across both columns), with no gap. Three-line phone rows were built and
  dropped before shipping (19:47 JST).
- **Rows 1.5× taller** (2026-11-03 23:01 JST: "卡片的高度再拉高那么一点… 1.5倍高度吧，
  现在的1.5倍"): 66px on touch, 42px on desktop (× the cards' text size),
  same columns and order. The room goes to the text, not to empty space: on a
  phone the example may wrap to a second line before its ellipsis (the
  meaning stays one line); on desktop each column may take two lines. A cut
  cell on the focused row slides up to its end and back. The swipe keeps its
  finger distance: one detent is still the old row height (44px), apart from
  the row's own (`rowMetrics`, `lib/words/row-layout.ts`).
- **The reader's review: one line more** (2026-11-08 19:16 JST, on /reader:
  "increase the height of every card by one more line"): a review opened from
  the reader (`StudyScope.extraLines: 1`) makes every row one line of its back
  text taller (14px × 1.25, × the text size) and gives that line to the
  example (phone: the first back line; desktop: each column). /words' own rows
  are unchanged. The reader's selection card shows one more line too: the
  selected sentence or paragraph is clamped at 4 lines (was 3), a new word's
  context at 3 (was 2), and the meaning and translation scrollers are one line
  (`1lh`) taller.
- **Pinch for card height** (2026-11-10, flag `words.pinch-card-height`, on for
  everyone): two fingers moved together or apart vertically on the list make
  every row shorter and denser or taller with more shown. Continuous under the
  fingers, settling on a whole line (no settle with motion off). The bounds
  are the cards': the word alone at the bottom, everything the rows on screen
  hold at the top. The lines go to the back cells as the default rows give
  them (`backLines`, `lib/words/row-pinch.ts`); the swipe unit stays. Synced
  as `words.cardHeight`, a factor of the default row. The page never zooms;
  a second finger cancels the rows' own gestures. Calm, and the list holds
  still (owner, 2026-11-10: too sensitive, and the whole list shook): the
  height follows the spread at a low gain past a small dead zone, eased
  (config `words.pinchGainPct` 40, `words.pinchDeadZonePct` 6,
  `words.pinchSmoothMs` 70); the row under the fingers stays under them,
  frame by frame, with no native scroll during the pinch; the height is one
  CSS variable (`--row-h`), so React renders only when a row gains or loses
  a whole line, and the pref is written once, when the pinch ends.
- **Reviewed words fade** (2026-11-10): a slip graded this session stays (for
  undo) but fades like a slip that came back: a veil and one muted ink at AA
  contrast (`.slip-done`, app/globals.css). Undo restores it.
- **Familiarity inside examples** (19:32 JST): an example's words that have
  one of his cards are marked by how well he knows them — solid line = weak,
  dashed = learning, mastered and card-less words plain (the reader's scheme,
  [books-plan.md](books-plan.md)). Matched as the reader matches a book
  (`normWord`, folds, lemma files); the page asks
  `POST /api/words/familiarity` once per word per session, for the rows it
  renders (`lib/words/example-marks.ts`). The marks hide with the answer.
- **Keep scrolling** (03:30–03:31 JST): he likes scrolling; with fixed slots
  his finger has to move to a different slot each time, while with scrolling
  it stays at one spot and swipes card after card. So after a swipe the next
  card arrives at the **same screen position** under his finger. He reported
  that /words could not scroll at 03:30 JST: check for a bug.
- **Paper texture always scrolls with the list**; the
  `words.paperScrolls` setting is removed.
- **Binding cords at a fixed position**: dragging a slip never carries the
  cords along (old and new swipe).
- A slip showing "↓ back"/「回来了」 is locked: no swipe, grade or undo (#427).
- **The first card opens in the middle** (2026-11-07 17:50 JST: "进入复习列表应该
  把第一张卡滚动到屏幕中间而不是在顶上"): /words and the reader's review list open
  with the first card's centre at the screen's centre, set at once on opening
  (no animation) and held there until the list is moved (`centredTop`,
  `app/(app)/words/ui-store.ts`). A word remembered further down still opens
  just under the toolbar.
- **Grade keys 1–4** (2026-11-04, PC, also the /reader word review): a word not
  graded yet is graded like a swipe — the list scrolls one row and the cursor
  moves to the next word. A correction (re-grading a graded word) never
  scrolls the view, but the cursor still moves to the next word
  (`keyGradeMove`, lib/words/advance.ts).
- **The last card focuses the way back** (2026-11-05, then 2026-11-06/07: "swiped
  last card… should focus into 返回", "review last word in list should focus
  into return btn"): grading the last word, by swipe or 1–4 with any grade,
  moves real focus to the button below the list and scrolls it into view; it
  looks focused (a `:focus` ring and tint) after a swipe too. Enter or G press
  it. G does nothing before the list is done or while typing in a field. A
  missed word's copy does not hold the end back: it can only join once the
  tail has left the screen. In a reader review every row counts; on /words a
  word browsed ahead of its due does not (`reviewEnded`, `listDone`,
  `app/(app)/words/study-done-back.tsx`).

## The window (phase 2, **open**: design options go to the owner in Slack)

- _Superseded in part by "Keep scrolling" above: no fixed slots._
- A **fixed visual window** of 3–4 slips. A swiped slip leaves its slot and
  the next word slides up from below or fades in (A B C → B C D).
- Slots are refilled in order of **forgetting probability**.
- **Swiped slips never vanish**: they stay reachable so a mis-swipe can be
  undone or re-graded.
- Gestures unchanged: left = learned, right = needs review.

## Session order

- **Due reviews before new words, by default**, every day ("像背单词软件"):
  if he only learns new words and runs out of time, old cards would never
  be reviewed.
- After a round: the not-learned words first, then the shaky ones. Learned
  words go to a **familiar bank** that returns for review later (FSRS due).
- The 「继续复习」 button after the last card: he asked whether the extra tap
  is needed (**open**: offer auto-continue as an option).

## Voice-command mode (fix to #421; done in #433, see [voice-mode.md](voice-mode.md))

- Speech that **strictly matches** a command on the **current screen** is
  carried out and does **not** wake the chat agent (a small line may show
  it was understood).
- Everything else goes to the chat as a normal message. A sentence that only
  contains a command word never triggers an action.
- Each screen registers its own commands (/words and review first);
  a screen with none sends everything to the chat.

## Elsewhere the same evening

- Text size setting: overall, chat, and study cards; follows the account.
- Typing glass covers only the chat box (input and messages), not the
  whole screen (#426).
- Agent ask cards can be withdrawn.
