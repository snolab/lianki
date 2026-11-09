# Planning tools — inventory and one source of truth

Tree: /plan/one-source

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
| **GitHub PRs + merge queue**                | landing code; CI                                                                                 | agents (`scripts/ship.ts`)                                      | CI, agents                                              | snolab/lianki                                                                                                                                 | PR numbers on nodes (`prs`), put there by ship.ts                         |
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

| #   | Step                                                                                                                                                                                                                                                 | Size | Deletes                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------- |
| 1   | **Done** (#744). This doc; AGENTS.md link                                                                                                                                                                                                            | S    | —                                                   |
| 2   | **Done** (#754). TODO.md removed (its two live items became `/backlog/prefs-a11y` and `/backlog/mobile-exclude`, the latter already fixed); #95 closed; #98 parked as `/backlog/cf-native`                                                           | S    | `TODO.md`, the issues                               |
| 3   | **Done** (#755). **Durable done history**: each done node leaves `{id, title, prs, endedAt…}` under `h:<id>` in the hub, no expiry; `progress.ts history`, `show --all` (docs/state-tree.md, "Done history")                                         | M    | —                                                   |
| 4   | **Done** (#758). **/dev/roadmap from the tree**: sections by node status, grouped by top-level path, PR chips, ETA, done history folded; `items.ts` entries moved into nodes (done ones back-dated with `--ended`)                                   | M    | `items.ts`, the `items.*` keys in `page.content.ts` |
| 5   | **Done** (#759). **PRs on nodes, always**: `scripts/ship.ts` reports `--pr N` on `--node` / `LIANKI_TASK_PATH` / the commit's `Tree:` line (docs/shipping.md, "The PR on its node")                                                                  | S    | hand-copied PR lists                                |
| 6   | **Done**, but the lint (below, "Design docs: the Tree line"). **Design docs link their node**: a `Tree: /path` line at the top of each stub/plan doc; the node gets `--link` to the doc                                                              | S    | to-do lists inside docs (they move to child nodes)  |
| 7   | **Done** (#760). **Ask cards and Slack asks attach to nodes**: `lianki-dev ask --node` required from a lane; question and answer noted on the node; Slack asks carry `Tree: /path` and the main lane writes the answer back (docs/lianki-dev-cli.md) | M    | the second "waits on owner" list                    |
| 8   | **Shrink state-tree.md** to the lane skeleton the hub lays nodes over (or drop it once step 3 lands)                                                                                                                                                 | S    | the stale 2026-10-30 content                        |

Order: 1 → 2 → 3 → 4 → 5, then 6–8 in any order. Bar, Gantt and ETA
notices need no change: they already read the hub.

**Step 4, titles (decided).** Node titles are free text in one language and
are shown as written (the owner reads zh/en); only the page chrome of
/dev/roadmap is translated (16 locales, context lines).

## Design docs: the Tree line

A design doc (a stub, a plan, anything with phases or a to-do list) names
its node in a line of its own right under the title:

```markdown
# Import any material (design stub)

Tree: /import/any
```

- One node per doc, a `/path`. The node carries the doc back: `--link
https://github.com/snolab/lianki/blob/main/docs/<doc>.md`.
- The doc keeps the why and the how; what is left to do lives in the
  node's children (`/import/any/m2`, …), not in a list inside the doc.
- The same line in a commit message tells `scripts/ship.ts` which node the
  PR goes on (docs/shipping.md, "The PR on its node"); the same line opens
  a Slack ask (docs/lianki-dev-cli.md, "Slack asks").
- Docs with the line so far: import-material, loader-hosting,
  userscript-li-chat, youtube-song-examples, framework-migration, this one.
  A new stub gets its node and its line in the same change.
- Not done: the lint that warns on a stub doc with no `Tree:` line.

## Should the study-plan tree share the engine?

No, not now. The dev tree is one owner-only Durable Object with a root
token, 200 nodes and 24-hour pruning; the study-plan tree is per-user,
private, durable D1 rows with tags and undo. Sharing storage would mix
user data with dev data and put the hub's limits on users. Share the
**ideas** and, later, the **views**: path addressing, status, ETA/Gantt
rendering (`StateTree.tsx`, `EtaBar.tsx`) can take either source once the
node tree exists. Revisit when calendar-plan phase 1 ships.
