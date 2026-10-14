# Idea: a generated feed — swipe through LLM-made cards at your level

_PRD: [generated-feed-prd.md](generated-feed-prd.md). Research behind the PRD revisions: [reports/TikTok recommendation algorithm internals.md](../../reports/TikTok%20recommendation%20algorithm%20internals.md)._

_Status: idea, captured 2026-10-14. Not scheduled. Builds on the swipe-to-grade
PoC in `scripts/poc/swipe-grade/` (horizontal swipe = grade by distance,
up = next, down = undo, haptic ticks on Android)._

## The pitch

Instead of swiping through the user's existing cards, swipe through **content
generated on the fly** — the TikTok loop applied to language learning. Each
card is a short piece (a sentence, a micro-dialogue, a caption, a clip prompt)
that an LLM writes for the user's _current_ level, and the next card is
generated from how the user handled the ones before it.

## Core rules

1. **Every bite is under one minute.** A card is designed to be read and
   graded in well under 60 s. The loop stays controllable only if each step is
   short.
2. **Reading time is the level signal.** How long a user spends on a card,
   relative to the card's length and difficulty, says more than a self-grade.
   Fast + "Good" means the level is right or too easy; slow + "Hard" means too
   hard. The algorithm that estimates level feeds on these timings.
3. **Cap the view time at 60 s and drop anything over it.** A record above the
   cap is discarded, not treated as "very hard" — reading simple content for a
   long time is meaningless as a signal (phone put down, distracted, tab left
   open). At the cap, show an **AFK overlay**; the card resumes with a fresh
   timer when the user taps.
4. **Generation follows the estimate.** The next card's difficulty, vocabulary
   band, and length come from the running level estimate, nudged up when the
   user is fast and accurate and down when they slow or fail.

## Sketch of the loop

```
level estimate ──► generate card (LLM, level-conditioned) ──► show
      ▲                                                        │
      │            swipe grade + view time (≤ 60 s, else drop) │
      └────────────────────────────────────────────────────────┘
```

- **Inputs per card:** card length and target level, view time (sub-60 s
  only), grade (Again / Hard / Good / Easy), undo events, whether the AFK
  overlay fired.
- **Level estimate:** start from the user's roadmap / known vocabulary
  (existing FSRS data), update with a smoothed reading-speed-per-difficulty
  signal. Reading speed on content at the right level should sit in a band;
  faster than the band suggests raising difficulty, slower suggests lowering.
- **Card generation:** prompt with the level, the recent vocabulary the user
  has seen, and what they failed; ask for one short item. Pre-generate one or
  two cards ahead so the swipe never waits on the model (see the `under` card
  in the PoC).
- **Persistence:** every graded generated card can become a normal Lianki card
  (same HLC sync path) so it enters FSRS review. Dropped records (over the cap)
  are not stored as reviews.

## Why this fits Lianki

- Watch-time tracking and the review-order preference already exist; the
  60-second cap is the same "active time only" idea applied per card.
- The swipe-to-grade gesture maps directly onto the four FSRS ratings.
- Generation can run on Workers AI / the existing LLM helpers (see
  `docs/workers-ai.md`).

## Open questions

- What is the reading-speed band per level, and per language? (CJK vs Latin
  scripts differ a lot in characters-per-second.)
- How to separate "slow because hard" from "slow because distracted" below the
  60 s cap. Candidate: scroll/tap activity during the view.
- Cost per card: generating per-swipe at scale vs. generating in small batches
  per level band and personalizing only the ordering.
- Where the content renders: the PoC overlays a YouTube embed. A self-controlled
  webview (the Tauri shell / a mobile wrapper) or the browser extension could own
  the gesture layer directly instead of fighting an embedded iframe for touches.

## Clip cards from YouTube (added 2026-10-14)

Cards need not all be LLM text. A **clip card** is `{ videoId, start, end }`:
the embed's `start`/`end` parameters (or `loadVideoById({ startSeconds,
endSeconds })` in the IFrame API) make the player stop at `end` and fire an
ended event, so a 60-second bite needs no download or re-hosting. The LLM then
picks the segment and writes the gloss instead of producing the media.

Where the segments come from:

- **Filmot** (https://filmot.com) — a search engine over YouTube subtitles
  (manual and auto-generated, any language) that returns the videos *and the
  timestamps* where a word or phrase is spoken. Access is via RapidAPI (paid
  tiers) and a Python wrapper. That turns "find a real clip containing this
  target word at roughly this level" into one query.
- The video's own transcript (timed captions) for cutting at sentence
  boundaries once a video is chosen. Not fetched anywhere in the repo yet.
- Similar sentence-mining sources to compare: Youglish (widget with language
  filters), PlayPhrase.me, Immersion Kit (Japanese).

Caveats: ads before the segment eat the 60 s budget, so start the timer at the
first playing state; pad `start` by about 0.5 s; check embeddability per video;
auto-generated subtitles are noisy for CJK, so prefer manual tracks for level
targeting; the whole source is a third-party dependency with quotas.
