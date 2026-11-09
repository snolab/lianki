# Planning tools — inventory and one source of truth

Written 2026-11-09 (owner, 15:41 JST: "Do we have several different
task-planning tools now? Tidy them up."). The owner chose this plan (option
A) at 18:0x JST the same day; the steps are being landed in order, and each
one marks itself done in the table below.

## Inventory (dev work)

| Tool                                        | For                                                                                              | Written by                                                      | Read by                                                 | Lives in                                                                                                                                      | Overlap                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **State tree + ProgressHub**                | what is in flight, who owns it, ETA, what waits on the owner                                     | agents (`progress.ts`, `lianki-dev progress`), owner check-offs | owner (chat Tree, top of /dev/roadmap), agents (`show`) | live: lianki-push Durable Object (`workers/push/src/progress.ts`); base: [state-tree.md](state-tree.md) (hand-edited, stale since 2026-10-30) | the hub — the base file duplicates it                                     |
| **ETA bar + Gantt**                         | time left, overruns                                                                              | — (views)                                                       | owner                                                   | `packages/debug-chat/src/eta.ts`, `EtaBar.tsx`, tree list                                                                                     | none: views of the hub                                                    |
| **ETA pings / overrun notices**             | an ETA passed: reason + new time                                                                 | hub alarm, agents (`--late`)                                    | owner (Li, read aloud)                                  | hub → chat hub                                                                                                                                | none: events of the hub                                                   |
| **/dev/roadmap list**                       | status board: doing / waiting / queued / planned / done, PR chips                                | agents, by PR                                                   | owner                                                   | `app/(app)/dev/roadmap/items.ts` + titles in `page.content.ts` (16 locales)                                                                   | **full** with the tree: same items, hand-copied, no ETA                   |
| **TODO.md**                                 | old backlog (2026-05/06)                                                                         | nobody since                                                    | nobody                                                  | repo root                                                                                                                                     | removed 2026-11-09 (step 2)                                               |
| **Design docs with "stub"/"plan"/"Phases"** | the why and how of one feature                                                                   | agents                                                          | agents, owner                                           | `docs/*.md` (e.g. import-material, loader-hosting, roadmap-next, books-plan)                                                                  | each keeps its own to-do list, not linked to a node                       |
| **GitHub PRs + merge queue**                | landing code; CI                                                                                 | agents (`scripts/ship.ts`)                                      | CI, agents                                              | snolab/lianki                                                                                                                                 | PR numbers copied by hand into items.ts and tree titles                   |
| **GitHub issues**                           | almost unused (3 ever; open: #95 CF migration, done in practice; #98 CF-native rewrite, shelved) | —                                                               | —                                                       | snolab/lianki                                                                                                                                 | dead                                                                      |
| **Ask cards / owner to-dos**                | a decision or approval from the owner                                                            | agents (`eval.ts ask`, `lianki chat ask`); hub `/@owner/…`      | owner (tap)                                             | chat hub; hub `/@owner`                                                                                                                       | two queues for "waits on owner"; `ask --task-path` exists but is optional |
| **Slack asks**                              | longer decisions, options, plans                                                                 | main lane (bot outbox)                                          | owner, AFK                                              | Slack #lianki                                                                                                                                 | answer is not written back to a node                                      |

**Not dev planning — product.** The learner's **/roadmap** (wish → LLM steps
→ progress from cards; `roadmap_goals`, [roadmap-next.md](roadmap-next.md))
and the **study-plan node tree** of [calendar-plan.md](calendar-plan.md)
(per-user D1, tags + views, the Learning Partner plans). They share the word
"roadmap"/"tree" with the dev tools and nothing else.

## Plan: the state tree is the one source of truth for dev work

Every dev task, decision and design is a hub node. Everything else is a view
of a node or a link to one.

| #   | Step                                                                                                                                                                                                                                      | Size | Deletes                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------- |
| 1   | This doc; AGENTS.md link                                                                                                                                                                                                                  | S    | —                                                   |
| 2   | **Done.** TODO.md removed (its two live items became `/backlog/prefs-a11y` and `/backlog/mobile-exclude`, the latter already fixed); #95 closed; #98 parked as `/backlog/cf-native`                                                       | S    | `TODO.md`, the issues                               |
| 3   | **Durable done history**: the hub prunes done nodes after 24 h; keep `{id, title, prs, endedAt}` of each done node (D1 table or the 30-day stats log, extended to forever)                                                                | M    | —                                                   |
| 4   | **/dev/roadmap from the tree**: groups by node status (doing, waiting-owner, open, done from step 3), PR chips from `--pr`/`#NNN`, ETA from the hub; one-off script turns each `items.ts` entry into a node (done ones with their PRs)    | M    | `items.ts`, the `items.*` keys in `page.content.ts` |
| 5   | **PRs on nodes, always**: `scripts/ship.ts` reads `LIANKI_TASK_PATH` and reports `--pr N` itself; the roadmap links each PR                                                                                                               | S    | hand-copied PR lists                                |
| 6   | **Design docs link their node**: a `Tree: /path` line at the top of each stub/plan doc; the node gets `--link` to the doc; a lint warns on a stub with no node                                                                            | S    | to-do lists inside docs (they move to child nodes)  |
| 7   | **Ask cards and Slack asks attach to nodes**: `--task-path` required on `ask`; the answer resolves the node's `/@owner/…` to-do; a Slack ask gets the node path in its first line and the main lane writes the answer back with `resolve` | M    | the second "waits on owner" list                    |
| 8   | **Shrink state-tree.md** to the lane skeleton the hub lays nodes over (or drop it once step 3 lands)                                                                                                                                      | S    | the stale 2026-10-30 content                        |

Order: 1 → 2 → 3 → 4 → 5, then 6–8 in any order. Bar, Gantt and ETA
notices need no change: they already read the hub.

**Open point for step 4.** `items.ts` titles are translated (16 locales);
node titles are free text in one language. Proposal: node titles stay as
written (the owner reads zh/en), only the page chrome is translated.

## Should the study-plan tree share the engine?

No, not now. The dev tree is one owner-only Durable Object with a root
token, 200 nodes and 24-hour pruning; the study-plan tree is per-user,
private, durable D1 rows with tags and undo. Sharing storage would mix
user data with dev data and put the hub's limits on users. Share the
**ideas** and, later, the **views**: path addressing, status, ETA/Gantt
rendering (`StateTree.tsx`, `EtaBar.tsx`) can take either source once the
node tree exists. Revisit when calendar-plan phase 1 ships.
