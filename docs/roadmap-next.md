# /roadmap — what to do next (plan, nothing built)

Written 2026-11-07 after the owner's review of /roadmap ("review it and see
what we can do on it"). The page today: the learner writes a wish, an LLM
splits it into up to 20 steps with keywords (`app/api/roadmap/generate`), the
goal is saved per user (`roadmap_goals`), and each step's progress is the share
of the learner's **page cards** (`fsrs_notes`) whose url or title contains one
of the step's keywords and that are mature (Review, stability ≥ 21 days;
`lib/roadmap/progress.ts`).

Product intent: language learning first; the Learning Partner plans and
adjusts the study plan with the learner (docs/partner-ai.md,
docs/calendar-plan.md). The roadmap should become the visible face of that
plan, not a separate toy.

Efforts are agent hours (wall-clock for one agent, including tests and QA).

| # | Item | Why | Effort |
| - | ---- | --- | ------ |
| 1 | **Count word cards, not only page cards.** Match step keywords against `word_cards` (term, list name, list language) as well as `fsrs_notes`; mature = the same FSRS rule. | Language learners study on /words; today a Japanese N3 roadmap stays at 0% however many N3 words they learn, because only page cards are counted. | 2–3 |
| 2 | **Link a step to word lists directly.** When the plan is made, let the generator (or the learner) attach catalogue lists to a step (`jlpt-n3-vocab` → step 3); progress for that step = that list's learned share. Keywords stay the fallback. | Keyword matching is fuzzy (an English keyword never matches a Japanese term); a list link is exact and is what "progress derived from cards" should mean. | 3–4 |
| 3 | **A step opens what to study.** Each step gets a "Study" action: the linked list on /words, a /learn import, or a /review filter by its keywords. | The roadmap shows progress but gives no way to act on a step. | 1–2 |
| 4 | **Roadmap = the plan subtree.** Store a roadmap as nodes under a node tagged `plan` in the node tree of docs/calendar-plan.md (one node per step, `fields.keywords`, `fields.lists`), with `roadmap_goals` migrated or kept as a view. | One plan for the page, the partner and the calendar; no second copy to keep in sync. Depends on the node tree landing first. | 5–8 (after the tree) |
| 5 | **The Learning Partner plans and adjusts it.** The partner already reads `roadmap_goals` (topic and up to 8 steps). Let it propose a roadmap from the chat ("I want to pass N3 in June"), reorder or add steps, and say which step is next — applied directly with undo and a change log, per the 2026-10-31 decision. | The owner's main line: the partner helps plan and keeps track with the learner. | 4–6 |
| 6 | **Dates and pace.** An optional target date per wish; from the learned share and the daily review history, show "on track / behind" and the next step's suggested start. Feeds the built-in calendar later. | "Keep track with you until you make it" needs a sense of time, not only a percentage. | 3–4 |
| 7 | **Edit a roadmap.** Rename, reorder, edit or delete steps; regenerate one step. Today a roadmap can only be generated whole or deleted. | Generated plans are rarely right the first time. | 2–3 |
| 8 | **Progress over time.** Store a daily snapshot of each roadmap's learned share (one row per goal per day) and draw a small trend line. | Motivation; also gives the partner something to talk about. | 2 |
| 9 | **Undo for delete.** The × deletes at once with no confirmation; add the app's usual undo toast. | One mis-tap loses a plan. | 0.5 |

Suggested order: 1 → 3 → 9 → 2 → 7 → 5 → 6 → 8; 4 when the node tree exists
(5 can start on `roadmap_goals` and move with it).

Also noticed while reviewing:

- The generator caps a roadmap at 20 steps while the partner summary reads up
  to 8; long plans are cut off in the partner's view.
- Progress reads every page card of the user per request (lean columns since
  this change). With item 1 it should become two indexed queries, or a cached
  per-goal count updated on review.
