# /words session spec (owner, 2026-11-03 02:58–03:25 JST)

What the owner asked for on /words in one evening, spoken while testing on
his phone. Written down so it is not lost. Status per item; PRs fill in as
they land. Design details that are still open are marked **open**.

## Layout

- **One tall slip per word.** Today a word is split over ~3 small cells and
  ~10 fit a screen, so the English meaning and examples are cut off. Merge
  them: one slip the height of 3 current cells holding the word, the English
  meaning and the example sentences, in large type with generous spacing
  ("大大的，不密密麻麻，不累眼"). Keep the vertical bamboo-slip list; he
  prefers it to single cards. _Top priority; phase 1._
- **3–4 slips per phone screen**, 5 at most.
- **Keep scrolling** (revised 03:30–03:31 JST, replacing "snap paging" and
  "no scroll-up"): he likes scrolling; with fixed slots his finger has to move
  to a different slot each time, while with scrolling it stays at one spot and
  swipes card after card. So after a swipe the next card arrives at the
  **same screen position** under his finger. He reported that /words could
  not scroll at 03:30 JST: check for a bug.
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
