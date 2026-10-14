# PRD: Generated feed (swipe through LLM-made cards at your level)

_Draft 2026-10-14, revised the same day with the findings of
[reports/TikTok recommendation algorithm internals.md](../../reports/TikTok%20recommendation%20algorithm%20internals.md).
Extends [generated-feed.md](generated-feed.md). Builds on the swipe-to-grade
PoC in `scripts/poc/swipe-grade/`._

## 1. Summary

A phone-first feed where every card is a short piece of target-language content
written for the user's current level, graded with one swipe, and timed. Reading
time, normalised by what the card should take, drives the level estimate; the
grade drives FSRS. Cards arrive in short thematic arcs so a session is
segmented, not fragmented.

**Promise:** one minute at a time, always at your level, never a backlog.

**Stance (from the research):** copy TikTok's loop, invert its objective. Keep
the per-user state that updates after every item, the staged selection, the
dispersion layer and the user sliders. Rank by learning value against a ~75 %
success target, never by dwell. Dwell is a feature, not a reward.

## 2. Problem and why now

Review today is a chain of page loads over cards the user once saved. It has no
answer for "I have five minutes and nothing due", and no way to raise difficulty
except by finding harder material yourself.

Two signals already exist and are unused for this:

- Watch time: the userscript records active wall and media seconds per video,
  counting only while visible and audible, with a 2 second tick cap that treats
  longer gaps as a stall (`src/lianki.user.ts`, `WATCH_TICK_MAX_S`). Stored per
  URL in `watch_stats`.
- Comprehension from playback rate: `packages/core/src/difficulty.ts` turns
  speed markers into a maturity score (geometric mean rate).

FSRS review logs hold every grade ever given. Nothing yet turns these into a
level, and no level field exists anywhere (roadmap goals are a free-text topic
plus nodes). The feed is the first consumer that needs one.

## 3. Goals, non-goals, metrics

**Goals:** a feed that fills idle minutes; a running level estimate from
normalised reading time and grades; generated cards that enter normal FSRS
review when graded; measurable delayed recall, not just engagement.

**Non-goals (v1):** video generation, speech grading, multi-user content sharing,
replacing the existing review flow, iOS haptics, ranking by time spent.

| Metric | Target | Why |
| --- | --- | --- |
| Next-day and one-week recall of feed vocabulary (A/B vs plain review) | not worse than review at equal minutes | The only metric that says the feed teaches |
| Observed / expected time ratio, median per learner | 0.7 to 1.5 after 30 cards | The level estimate has converged |
| Views hitting the time cap | under 15 % | Higher means cards are too long or idle detection is wrong |
| Session success rate (Good or Easy) | 65 to 80 % | The ~75 % difficulty target is being hit |
| Cards graded per session | 8 or more | A session is worth opening the app for |
| Share of feed cards later reviewed in FSRS | over 50 % within 7 days | Generated content is becoming real knowledge |
| D7 retention of feed users vs non-feed | +10 points, logged next to session length | The loop holds people without turning into a time sink |

## 4. Users and scenarios

- **Phone, standing in a queue.** Opens the feed, swipes through one or two
  arcs in four minutes, puts the phone away. Android gets haptic ticks; iOS
  gets visual feedback only (no Vibration API in WebKit).
- **Desktop between tasks.** Same screen, keys 1 to 4 grade, W next, S undo,
  Space plays media.
- **Learner leveling up.** Fast and accurate for a week, cards get longer and
  denser without any setting changed.

## 5. UX spec

**Screen.** Full-height card stack (current card plus a dimmed `under` card),
a four-zone grade meter above it, a status strip below with the tally and a
"controls" toggle for embedded media. Layout is the PoC's `frame.html` and
`clips.html`.

**Arcs.** Cards are served in arcs of three to five that share a story,
character or grammar target, with the surface form varied inside the arc. The
research contrast is direct: one-minute segments of a coherent whole retain as
well as the long version, while clips interleaved with unrelated filler lose
most of the gain overnight. An arc boundary is visible (a thin divider card)
and is the natural session end.

**Gesture map.** Thresholds are the PoC values. Axis locks after 10 px of travel.

| Gesture | Distance | Action |
| --- | --- | --- |
| Drag left | 36 to 149 px | Hard |
| Drag left | 150 px or more | Again |
| Drag right | 36 to 149 px | Good |
| Drag right | 150 px or more | Easy |
| Drag up | 72 px or more | Skip; honoured only after the minimum exposure, else snaps back with a hint |
| Drag down | 72 px or more | Undo last action |
| Tap | under 10 px | Play or pause media, or flip to the gloss |
| Release under threshold | | Snap back, no event |

**The grade is the learning event.** A card never advances without a grade or
a skip. A skip is recorded as missing data for the level model and never as a
positive signal. Minimum exposure before a skip is honoured: 5 s or 40 % of the
card's expected time, whichever is larger. This blunts the attention-training
effect of fast swiping and keeps the time ratio meaningful.

**Haptics** (`navigator.vibrate`, Android only; silent no-op elsewhere):

| Event | Pattern (ms) |
| --- | --- |
| Crossing into a grade zone while dragging | 12 |
| Again | 40, 60, 40 |
| Hard | 80 |
| Good | 30 |
| Easy | 20, 40, 20, 40, 20 |
| Skip | 15 |
| Undo | 15, 40, 15 |
| Clip reached its end mark | 10, 30, 10 |

**View timer.** Starts when the card becomes the top card and the tab is
visible; pauses on `visibilitychange` hidden; the pause rule mirrors watch time
(visible only). Each view stores the raw visible seconds, the capped seconds,
the card's expected seconds, the interaction count and the number of
focus-loss events.

**Time cap (replaces "drop over 60 s").** The cap is content-aware: three times
the card's expected time, floor 20 s, ceiling 60 s. When the cap is hit the
**grade is kept and only the time signal is discarded**: a learner who sat with
a hard card for 70 s and pressed Again gave a valid grade. A capped time never
counts as "slow reader" evidence. Focus-loss events (tab hidden, app
backgrounded, no touch for 20 s) are stronger idle evidence than any dwell
number.

**AFK overlay.** Fires at the cap when there has been no pointer or key event
in the last 20 s. Shows a dimmed card, "Still here?", and the elapsed time. Tap
resumes the same card; the view is marked capped. Three AFK overlays in a row
end the session with a summary.

**Session end.** A session ends on its own at the end of the second arc or at
8 minutes, with a summary and a "one more arc" button. Distributed practice
beats massed practice; the stop is part of the product, not a nuisance, and
TikTok's own soft limit (about 1.5 min/day effect) shows that a dismissible
nudge does nothing.

**Undo.** A stack of `{cardId, grade | skip}`. Down-swipe pops one entry,
restores the card, reverses the tally, and reverts the level update for that
card. Undo is not stored as a review; a re-grade after undo replaces the
previous one before sync.

**Pre-load.** The current arc is fetched whole; the next arc is requested when
the user is two cards from the end of the current one.

**Offline.** Pre-loaded arcs remain usable. Grades queue through the existing
sync queue (`add` then `review`, HLC-stamped). Generation waits; the feed shows
"back online to continue" after the stack empties.

## 6. Level model: two models, not one

To be designed; this is the proposed v1. The split follows Duolingo and Anki:
an ability estimate decides **what** difficulty to generate next; FSRS decides
**when** a known item comes back. Reading time feeds the first and never the
second.

**Ability `L`.** An Elo/IRT scalar on a 1 to 10 band scale. Each card carries a
difficulty `d` seeded from its generation parameters (target band, vocabulary
frequency band, sentence count), the way Birdbrain V1 sums component features,
and refined from outcomes. Update after every grade:

```
expected = 1 / (1 + 10^((d - L) / 2))          # P(Good or Easy)
outcome  = 1 for Good/Easy, 0 for Again/Hard
K(n)     = 1 / (1 + 0.05 n)                      # decays with cards seen
L       <- L + K(n) * w(t) * (outcome - expected)
```

`w(t)` is the "high speed, high stakes" weight from the time ratio: 1.0 when
the observed time is at or under the expected time, falling linearly to 0.2 as
it approaches the cap, and 0 when the view is capped. A fast correct answer is
strong evidence; a slow correct answer is weak evidence; a capped view is no
time evidence at all. The target success rate is 75 %; the generator aims one
step above `L` when the recent success rate exceeds 80 % and one step below
when it falls under 65 %.

**Expected time.** Computed from sentence and clause count, not characters:
time per matched sentence is roughly invariant across scripts, so one rule
serves Japanese, Chinese, Korean and Latin-script targets. The learner's own
rate is a running median over their last 15 Good-graded cards, seeded from
literature values (L2 readers run about half L1 speed; a 30 to 45 s card holds
roughly 40 to 80 L2 words or 80 to 150 CJK characters). No CEFR-, JLPT- or
HSK-indexed rate table exists, so P1 measures the per-learner distribution
before any time weight is enabled.

**Guard rails.** Per-session drift of `L` is bounded to one sub-band. Three
consecutive Again grades step the generator down a band for the rest of the
arc regardless of `L`. Three consecutive Easy grades step it up one.

**Initial value.** A placement picker (band self-report, or "N3" style text
from the roadmap topic mapped to a band), then a two-card calibration at
`L - 1` and `L + 1`; `K` is large for the first cards so the estimate moves
fast and settles within tens of cards.

**Hard vs distracted.** Both are slow; they differ in activity. A hard read has
tap or scroll events (gloss flip, replay) and ends with Again or Hard. A
distracted read has no events and often ends with Good. Rule: a view with zero
interaction events, over twice the expected time, graded Good or Easy, gets
`w(t) = 0.3`.

## 7. Content generation

**Card types (v1):** single sentence with gloss on flip; two-line dialogue;
caption for a short YouTube clip cut from the caption track (the PoC
`clips.html`). Later: cloze, listening.

**Arcs first.** The generator is asked for an arc of three to five cards with
a shared story, character or grammar target and varied surface form, not for
single cards.

**Prompt inputs:** target language and script, band (`L` rounded, adjusted by
the guard rails), the last 30 vocabulary items seen, the last 10 failed items,
the roadmap topic if any, card type, arc length. Output is strict JSON per
card: `text`, `gloss`, `vocab[]`, `sentence_count`, `difficulty`.

**Level validation before serving.** LLMs write at near-native complexity by
default and prompting alone fails for beginners (a Japanese study moved
beginner comprehensibility from 39 % to 83 % only with constrained
generation). Every card is checked automatically against its band: a
vocabulary-frequency check against the band's word list and a sentence-length
and kanji or character-level check for CJK. A card that fails is regenerated
with the constraint tightened, at most twice, then dropped.

**Model.** `WORKERS_AI_MODEL` (llama-3.3-70b fp8 fast) through the existing
`lib/workers-ai.ts` client, same pattern as `app/api/ai-sentences/generate`
(authenticated, rate-limited, temperature 0.8). Use the HQ model for
calibration cards and for beginner bands where level control is hardest.

**Batching.** One arc per request. Keep the current arc plus the next in the
client. Per-swipe generation is too slow and too costly.

**Cache.** A per-band pool of arcs keyed by `(lang, script, band, type)` in
D1, shared across users, excluding arcs a user has already seen.
Personalisation is in the ordering and in a 1-in-3 user-specific arc that
targets their failures.

**Dispersion.** Applied at the word-and-pattern level, not the topic level: no
two consecutive cards drill the same target word or pattern; the arc keeps the
topic.

**Moderation.** The system prompt restricts topics to everyday, educational
content; a lightweight profanity filter on output; user "report" on the card
menu drops the arc from the pool.

**Cost.** `docs/workers-ai.md` records no pricing, so no ceiling can be stated
today. P1 must measure tokens per arc and set a ceiling before P2.

## 8. Data model and sync

A generated card is a normal `fsrs_notes` row once graded, with a synthetic URL
`lianki://feed/<cardId>` (so `normalizeUrl` and the HLC path work unchanged),
`title` set to the card text, and the generated payload in a new `meta` JSON
column. Until graded or skipped it exists only in the pool.

| New | Where | Purpose |
| --- | --- | --- |
| `feed_arcs` | D1 | pool: id, lang, script, band, type, cards JSON, validated_band, created_at, reports |
| `feed_cards` | D1 | id, arc_id, position, difficulty, sentence_count, payload JSON |
| `feed_views` | D1 | per user: card_id, raw_s, capped_s, expected_s, capped (bool), interaction_count, focus_loss_count, grade or skip, hlc |
| `preferences.feed_level` | D1 | `L`, cards seen `n`, running median rate |
| `preferences.feed_enabled` | D1 | the beta flag |

Capped views keep their grade: they create the `fsrs_notes` row and the review
log entry like any other graded view, and only their time is excluded from
the ability update. Raw and capped seconds are both stored so the cap rule can
be re-evaluated offline. Skips are written with `grade = null` and never create
a review. Grades sync through the queue as `add` then `review`, HLC-stamped,
and merge by the existing rules (LWW on the card, union on the log). Undo
before sync removes the queued items; undo after sync is not supported in v1.

## 9. Rendering surface

Web page first, inside the app at `/feed`, so the PWA and the Tauri shell in
`packages/desktop` get it for free. Embedded media sits under a transparent
gesture overlay as in the PoC; the overlay owns the pointer and forwards taps
as play or pause. Later the Tauri shell or the browser extension can own the
gesture layer directly and render third-party pages without fighting an iframe
for touches.

## 10. What we take from TikTok, and what we invert

| TikTok / Douyin mechanism (confirmed) | Feed analogue | Keep or invert |
| --- | --- | --- |
| Score = sum of P(behaviour) × V(behaviour), play-time dominant | Score = learning value: closeness of P(recall) to the 75 % target, novelty of target vocabulary, FSRS due-ness | Invert |
| Minute-level online updates; request-time sequence features | Ability and FSRS updated synchronously after every grade; last N grades and time ratios as features | Keep |
| Recall → coarse rank → fine rank → dispersion | Generate or retrieve an arc pool at `L ± 1`, validate against band, rank, disperse | Keep |
| New item cold start from first impressions, follower count ignored | New card difficulty seeded from generation parameters, refined from outcomes | Keep |
| No two consecutive videos from the same creator or sound | No two consecutive cards drilling the same word or pattern | Keep, at skill level |
| Repetition limits on sensitive clusters | Cap consecutive Again grades; bound per-session drift | Keep |
| Interest picker, then personalisation within 100 to 260 items | Placement picker, then Elo with decaying K converges in tens of cards | Keep |
| Soft 60-minute limit (about 1.5 min/day effect) | Hard session end at the arc boundary; spacing is the product | Invert |

## 11. Phased rollout

| Phase | Scope | Proves |
| --- | --- | --- |
| P0 (done) | PoC: gestures, meter, haptics, YouTube overlay, caption-cut clips, tunnel demo | Gesture map and thresholds feel right on a phone |
| P1 internal | `/feed` route, arc generation with validation, view timer, cap and AFK overlay, `feed_views`, time weight off | Cards are readable at band, cost per arc, cap rate, per-learner expected-rate distribution |
| P2 beta | `feed_enabled` preference, ability model live with time weight, graded cards enter FSRS, undo, offline queue, session end | Ability converges; success rate sits near 75 %; metrics in section 3 move |
| P3 GA | Default on, pool sharing across users, report flow, next-day and one-week recall A/B vs plain review | The feed teaches, and retention holds without session-length inflation |

## 12. Risks and open questions

- **Attention cost of the swipe interface.** Heavy short-form use correlates
  with poorer attention and inhibitory control (71-study meta-analysis,
  causality unresolved). Mitigations: arcs, grade-before-advance, minimum
  exposure, hard session end. Watch session length next to retention.
- **Fragmentation.** If arcs break (cache misses mixing arcs, user-specific
  cards inserted mid-arc) the overnight-forgetting effect returns. The pool
  serves whole arcs only.
- **Level control in generation** is weak for beginners with prompting alone.
  Validation before serving is mandatory, not optional; measure the
  regeneration rate per band in P1.
- **Expected-rate seeds are guesses.** P1 collects per-learner rates with the
  time weight disabled before any update uses them.
- **Infinite-scroll liability.** The European Commission's 2026 DSA findings
  target recommender plus autoplay and endless feeds. The session end and the
  non-personalised "plain review" path keep the feed on the right side of that.
- **Unofficial caption path for clip cards.** YouTube's web caption URLs now
  need a proof-of-origin token; the PoC uses the InnerTube Android client,
  which can break without notice.
- Synthetic URLs leak into places that expect a real page (open-in-browser,
  review chain). Audit `lib/next-card.ts` and the userscript's URL handling.
- iOS has no haptics on the web; is the feed good enough without them?
- Open evidence gap: no randomised study of a swipe-graded language feed with
  delayed outcomes exists. P3's recall A/B is Lianki producing that evidence,
  not consuming it.
