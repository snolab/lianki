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
