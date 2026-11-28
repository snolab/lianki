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

## Built: 2a, the roadmap model and page (2026-11-28)

The owner's 2a request, on top of the robust generator (#1160).

- **Ordering notation.** A step has `stage` (1, 2, 3: one after another) and,
  when it shares the stage, `lane` (A, B, C: side by side), shown as
  `1, 2A, 2B, 2C, 3` (`lib/roadmap/notation.ts`). The generator asks for a
  `step` label and `fitRoadmap` keeps it; saves and reads go through
  `normalizeSteps`, which makes stages dense, letters only for shared stages,
  and reads a roadmap saved before the notation (plain `order`) as one stage
  per step. No data migration: old rows normalize on read and on the next save.
- **Step kinds.** `keywords` (the old page-card match, the default), `deck`
  (a catalogue word list by id; the generator may only use the exam decks
  `matchExamDecks` found for the wish) and `doc`: Markdown of its own, a
  /reader doc (`readerId`) and/or an official page (`url`). A doc's progress =
  ticked / all task items `- [ ]` `- [x]`, nested ones included, code fences
  skipped (`lib/roadmap/doc-checklist.ts`); no task items = n/a. The
  checkboxes on /roadmap toggle and save back (PATCH `/api/roadmap/<id>`).
- **Images in a doc** go through the user's file store (source `roadmap`,
  `lib/roadmap/doc-image.ts`): the account's `files.quotaBytes`, listed on
  /my/files under "Roadmap images", the Markdown holds `/api/my/files/<id>`.
  A full file space refuses the image with a link to /my/files; the Markdown
  is untouched and still saves (the PATCH never touches the store).
- **Estimate instead of "NN% complete".** Per step and for the whole
  roadmap, from the learner's own log over `roadmap.paceWindowDays` (14):
  new words a day in their lists of a deck (`word_reviews`, state New), items
  ticked a day for a doc (`doc.doneLog`). Recent days weigh more. Fewer active
  days than `roadmap.paceMinActiveDays` (3) says "too little history". The
  whole roadmap: each stage as long as its slowest lane, stages add up
  (`lib/roadmap/eta.ts`). The percentage stays, small.
- **Target date and pace.** A pencil button edits the goal and its target
  date (`roadmap_goals.target_date`, migration 0088). The pace indicator shows
  all four states (on pace, ahead, behind, no data) with the active one
  filled seal red; behind says by how many days and the daily amount needed
  ("need ~20 new words a day to hit 1 March"). It recomputes in the page as
  the date changes. "Ahead" = at least `roadmap.aheadDays` (7) early.

Strings: `roadmap-steps` (`app/(app)/roadmap/roadmap-steps.content.ts`).
Tests: `unit/roadmap-model.test.ts`.

## Generation transport and safe failure diagnostics (2026-11-29)

`/api/roadmap/generate` explicitly selects a Workers AI structured-generation
transport through `workersAiStructuredModel`: Chat Completions for the default
Llama model and Responses for the two GPT-OSS models. Calling the AI SDK provider
as a function defaults to Responses, which is not available for other Workers AI
models ([Cloudflare compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)).
The regression exercises the real SDK request/response parser with a fetch stub,
including the fitted output's save contract and truncated-output retry.

The roadmap still uses its own credit hold and account request limiter; it does
not consume `partner.userWindowTokens`. Output limits, attempt count, pricing and
credit settlement are unchanged. Failed generation logs contain only an error
identifier, HTTP status and bounded finish reason, never the provider's message,
prompt or generated text. The page's generic failure can also mean its subsequent
save failed: verify POST `/api/roadmap/generate` and POST `/api/roadmap` separately.

Tree: /roadmap/jlpt-generation

The production generation helper disables SDK-internal retries (`maxRetries: 0`).
Only the outer two-attempt loop retries invalid model output; retryable HTTP
responses do not silently multiply calls beyond the reserved budget. Synthetic
429/500/503 tests invoke that same production helper.
