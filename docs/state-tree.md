<!--
The state tree: what is in flight and what waits on the owner. Hand-edited
by the owner and by agents. The plan (lanes) comes first; an item lives in
one place only. The owner reads it in the Learning Partner chat
(menu → Tree) and at the top of /dev/roadmap; the tree marks its frontier:
✓ the latest done, ▶ in progress, › next. The chat's minimized bar shows only
live in-progress items (reported to the hub), as their ≈ line. Parser and rules:
packages/debug-chat/src/state-tree.ts. The repo is public: no personal info.

Syntax
  ## Heading               a top-level node
  - item                   nested by indent under the item above it
  [ ] [~] [!] [x]          open / in progress / blocked / done
  (!)                      waits on the owner (shown before anything in progress)
  (any order)              the item's children are unordered (otherwise file
                           order is the order of work)
  (done 2026-10-30T01:12)  on a [x] item: when; the latest is "most recent"
  … @owner                 trailing: the assignee. @owner is the human; any
  … @slug / @slug#id       other @slug is an agent, optionally with an opaque
                           id ([A-Za-z0-9_-], up to 40 chars, nothing else).
                           Children inherit the nearest ancestor's assignee.
  → command or URL         a line under an item: its action (copy button)
  ≈ done: … · doing: … · next: …
                           under a node (or above the first ##, for the whole
                           tree): one-phrase summaries of its status groups.
                           Bare ≈ is zh, a 4-character 成语; ≈en, ≈ja, … are
                           other locales. Agents: when a group holds several
                           items in one status, write a ≈ summary. Nothing is
                           generated at runtime.
  #NNN                     a Lianki PR; owner/repo#N a PR in that repo

Live
  Deployed, the owner's chat reads the copy bundled at commit time
  (GET /api/dev/state-tree; scripts/gen-state-tree.ts). With the widget
  hot-loaded (lk:debug-widget-src, docs/dev-debug-widget.md) it reads this
  file from the dev server instead (/state-tree.md) and refetches on every
  save (SSE `tree`; fs.watch, no polling); a green dot by "Tree" says so.

Live progress (lib/progress-tree.ts, workers/push/src/progress.ts)
  This file is the hand-edited base. Agents report progress to lianki-push's
  ProgressHub; the owner's views (chat Tree, /dev/roadmap) hold one
  owner-only WebSocket (/api/version/progress) and lay each live node over
  this outline by path: "/words/swipe" updates "## /words" › the item whose
  first word or title slugs to "swipe" (status, (!), assignee, action,
  links; pct · ETA · needs · latest note go in its note), or adds it there.
  A slug id with no path lands under "Live". No secret, no hub, not the
  owner: the outline shows as written. Nothing polls.

  Report (one POST, then exit):
    bun scripts/dev/progress.ts --agent <you> --path /words/swipe       --task "Native swipe: drag the card with the finger" --status doing --pct 40 --eta 15m
    … --done --pr 310        when it lands
    … --status blocked --note "why"
    … --status waiting-owner --needs "OK the preview" --kind approval
  --task is "name: description" (':' or '：'): a short name of 1–20
  characters (graphemes, not bytes), then what it is. The owner's ETA bar
  shows only the name; the full list shows both. A longer name is refused
  (with an example); a title with no colon still goes through, with a
  warning when it is over 20.
  status: doing | blocked | waiting | waiting-owner | review | done
  kind:   task | decision | approval | feedback | person
  --path sets id and parent (missing ancestors become groups); --id/--parent
  for a slug; --ref, --action, --link, --note (appends), --rev N (409 if
  stale), --human (a human assignee; --agent is the name).

  Nodes. Every node has an id (a /path, or a slug), a parent, an assignee
  {type: agent | human, name} and the agent that created it. /@owner is the
  owner's node (kind person, human assignee "owner"; his name is shown,
  never stored). His to-dos are /@owner/<slug> with --ref to the node they
  unblock; resolving one also resolves the decision or approval it refs:
    bun scripts/dev/progress.ts resolve --id /@owner/<slug> --note "answer"

  Scopes. PROGRESS_TOKEN (a lianki-push secret; .dev.vars locally) is the
  root: it writes anywhere. A scoped token covers one node and its subtree
  (a path's descendants; a slug's by stored parent links):
    bun scripts/dev/progress.ts grant --node /words --agent swipe-agent --ttl 8h
  It is base64url(JSON {node, agent, exp, via}) "." HMAC-SHA256(root, payload),
  minted by the hub only (a scoped token asks for a narrower one the same
  way; never past its own expiry, at most 7 days). With it an agent writes
  only as its own name, only inside its scope; a new node needs a parent
  inside it; nothing moves out of it. Status, pct and ETA are the creator's
  (or a scope above). Any agent may add an /@owner/… to-do whose ref is in
  its scope. Any valid token reads the whole tree (`show`). The token is
  --token, LIANKI_PROGRESS_TOKEN, PROGRESS_TOKEN or .dev.vars.

  ETA pings (flag chat.eta-bar, owner only). --eta is the agent's own
  estimate, given each time it reports: a duration from now (25m, 1h30m), a
  range (12m-63m) or an ISO time with its zone. The hub turns it into the
  node's etaAt on its own clock; a new --eta moves it; free text ("after CI")
  is shown, no timer.
    bun scripts/dev/progress.ts --agent <you> --path /words/swipe --task "Native swipe: drag with the finger" --status doing --eta 12m-63m
  A range is P5–P95 of what the task may take (owner, 2026-11-10): etaMinAt is
  the P5, etaAt the P95. Everything that means "late" counts from the P95:
  the red "-5M", the "ETA reached" ping below, and the overrun rule; a new
  --eta between the two needs no --late. Labels read "12–63M" (one unit
  shared) until the P5 passes, then the time to the P95. The Gantt draws the
  bar solid to the P5 and a tail fading out to the P95. One number is a range
  of one: no P5, as before.

  ETA history (owner, 2026-11-10). Each node keeps its last 24 ETA events
  (etaEvents, oldest first): {at, kind: change | confirm | status, oldEtaAt?,
  newEtaAt?, oldEtaMinAt?, newEtaMinAt?, status?, by, changeId}. A change is a
  new estimate (no newEtaAt: cleared by free text); a confirm says the
  estimate still holds; a status event is a change of status. The first time
  set is also kept as `plan` {start, etaAt, etaMinAt?}, never moved: the
  Gantt's faint ghost bar, the original plan.
    bun scripts/dev/progress.ts --agent <you> --path /words/swipe --task "<same>" --status doing --confirm
  re-confirms an unchanged estimate cheaply. It counts as on track: no --late,
  no new time; only before the ETA (a passed one is an overrun: a new --eta
  with --late). A change or a confirm stamps etaConfirmedAt; `show`, --json
  and the readers' feed give it with "etaConfirmedAgo" ("7 min ago"), so a
  coordinator spots a stale estimate.
  One action across several nodes (a re-plan) shares one changeId and one
  time, so its ticks line up on the Gantt and a tap shows the group ("moved
  up: A; postponed: B, C"):
    bun scripts/dev/progress.ts batch '[{"agent":"<you>","path":"/x/a","task":"A: …","eta":"20m"},{"agent":"<you>","path":"/x/b","task":"B: …","eta":"1h-2h"}]'
  (POST /batch {changeId?, reports}: each item keyed by the flags, at most 20;
  all are checked before any is written), or --change-id <id> on separate
  calls: the hub keeps the first call's time for 10 minutes. Without either,
  every write is its own change.
  The owner's chat shows one summary line above the input, its background
  filled to the weighted progress (time left, next due;
  packages/debug-chat/src/eta.ts, EtaBar.tsx); a tap opens a full-screen
  Gantt of every timed task, scrollable through time and zoomable
  (GanttFull.tsx), and this tree lists them as compact Gantt rows
  (docs/dev-debug-widget.md, "ETA bar", "Full-screen Gantt"). Time labels are "5M", "1.5H", and "-5M" in red past due. His box
  shows the same, on a box chat ticket (docs/box-oauth.md).
  When etaAt passes on an open node, the hub (Durable Object alarm; also an
  owner page's one timer sending {type:"eta", id}) marks it etaSent and asks
  the chat hub (POST /internal/eta over the DEBUG binding, lib/eta-ping.ts) to
  post one line in the owner's thread, to "/":
    "ETA reached for <task> (<id>): <lane>, within 5 min tell the owner WHY
     and a new "N minutes from now" — bun scripts/dev/progress.ts … --eta <N>m
     --late "<reason>" … Otherwise he is told "<name> 超时，未说明原因"."
  from "agent", agentId "eta", source "eta", quiet. Every listener at "/" (the
  chat lane's `eval.ts chat`) hears it as it hears his lines; eval.ts prints it
  with "source":"eta","auto":true. It is never the owner speaking, never an
  answer to an ask card, never an approval. One line per estimate, whatever
  number of pages are open; a done node gets none.

  ETA overrun — a standing rule for every lane (owner, 2026-11-08 20:24 JST).
  A task that reaches its ETA unfinished owes the owner, within 5 minutes
  (ETA_EXPLAIN_MS), the REASON and a new "N minutes from now", in one call:
    bun scripts/dev/progress.ts --agent <you> --path <node> --task "<same>" --status doing --eta 20m --late "CI 排队太久"
  The hub stores the reason on the node (lateReason, and lateFor = the etaAt
  it explains; a "late: …" note too) and posts the owner's thread
  "<name> 超时：<reason>。再要 20 分钟" — read aloud, not quiet. Write the reason
  in the owner's language. Once a node's etaAt has passed, a new --eta without
  --late is refused (400); --late without an --eta that sets a time is a usage
  error. Progress without a new estimate (--pct, a note) and --done need none.
  If neither a reason nor a new estimate comes within 5 minutes of the
  "ETA reached" line, the hub's alarm posts the owner "<name> 超时，未说明原因"
  (read aloud), once per etaAt (marked etaSilent). Never let him find out
  from that line.

  Waiting on the owner (owner, 2026-11-10 21:47 JST). A node that waits on
  HIM — status waiting-owner, something in `needs`, or kind decision /
  approval (lib/owner-wait.ts) — is not late work when its etaAt passes. It
  gets no "ETA reached" lane line and never "未说明原因". Instead the owner
  hears ONE reminder that carries the reason, read aloud like the overrun
  lines (same send path, ping kind "waiting"):
    "<name>：在等你——<needs>"      ("<name>：在等你" when needs is empty)
  and the hub schedules the next one itself, further out each time: the
  config key chat.ownerWaitRemindDays (lib/config.ts, editable at
  /dev/config; default "1,3,7" = a day after the first, then 3 days, then
  7, then weekly, the last spacing repeating). The hub reads it over the main
  Worker's DebugSessions.config RPC and uses the default when it cannot. The
  node keeps remindFor (the etaAt they belong to), remindN (sent) and
  remindAt (the next). Moving its time needs no --late; a new etaAt starts
  over (first reminder at that time). The reminders stop when it stops
  waiting on him: done, resolved by him, or a write that leaves
  waiting-owner and clears needs. Coming off waiting with the old, passed
  etaAt marks it pinged and silent, so the lane is not told it is late for
  time spent waiting on him; a lane past its ETA that hands the node to him
  (waiting-owner + needs) has his reminder sent at once instead of
  "未说明原因". Nodes pinged before this existed start their reminders one
  spacing out, with no line at deploy.

  Timing, for agents only (never shown to the owner: his bar and list keep
  the time left and the names). Each node keeps startedAt (its first write
  with status doing), endedAt (when it went done; cleared if it reopens),
  estimateMs (the first --eta that set a time, as a duration from when it
  was given) and etaRevisions (estimates after it). `show` returns them.
  Each task that goes done (a report or the owner's check-off) also leaves
  {agent, id, title, estimateMs, actualMs, revisions} in a durable stats log
  (keys "d:", 30 days, newest 1000; never sent to pages), read with GET
  /stats:
    bun scripts/dev/progress.ts stats [--agent <you>] [--since 7d]
  per agent, done tasks with estimate vs actual and the median actual/estimate
  ratio — multiply your next --eta by it.

  Done history (docs/planning-tools.md, step 3). The live tree still drops a
  done node 24 h after its last write (the bar, the Gantt and this tree show
  only recent work), but each node that goes done first leaves a record
  {id, title, agent, kind, parent, prs, link, created, startedAt, endedAt,
  estimateMs} in the hub's durable done history: keys "h:<id>", one per id
  (done again: replaced), no expiry and no cap — a record is ~300 bytes, a
  few thousand a year. Groups and people are not recorded. The first read
  copies in the stats log's 30 days (no PRs) and done live nodes, once
  (key "hmig"). Read it with GET /history?limit=N (newest first, default
  500, at most 2000; any valid token):
    bun scripts/dev/progress.ts history [--agent <you>] [--since 30d] [--json]
    bun scripts/dev/progress.ts show --all     # the tree plus "history"
  or, on an owner/box reader socket, {type:"history", limit?}: the answer
  {type:"history", items, total} goes to that socket only, never in the
  snapshot, so the ETA bar and Gantt see nothing new. /dev/roadmap lists it
  (lib/roadmap-tree.ts: open nodes by section, done history folded, both
  grouped by top-level path; node titles as written). Any write to a done
  node refreshes its record (a later PR reaches it). Old work moved in after
  the fact: --done --ended <ISO time> (root token only) back-dates it; such a
  node stays out of the stats log.
  PRs: --pr 703,707 (or one per report); a node keeps every PR it named in
  `prs` (newest 20), and "#NNN" in its title counts too.

  Limits: name 40, task 120, note 280, needs 120; 24 ETA events a node; 200 nodes (oldest done
  dropped first); done nodes pruned after 24 h (Durable Object alarm; the
  done history keeps them); a
  200-event log; 30 writes/min per name, 120 in all. Unset secret: 503.
  Owner to-dos to start with: scripts/dev/progress-seed.ts (idempotent).
-->

# Lianki — state tree (2026-10-30)

Legend: [ ] open · [~] in progress · [!] blocked · [x] done · (!) waits on you · → command or link

≈ done: 捷报频传 · doing: 多线并进 · next: 蓄势待发
≈en done: Wins keep coming · doing: Many fronts at once · next: Ready to go

## Plan — everything in parallel (2026-10-30)
≈ done: 捷报频传 · doing: 多线并进 · next: 蓄势待发
≈en done: Wins keep coming · doing: Many fronts at once · next: Ready to go

- Lane E · /words, new swipe — TOP priority (owns WordsClient, words CSS, qa-words, public/proto) @main-lane
  ≈ doing: 当务之急 · next: 先验后行
  ≈en doing: First things first · next: Verify, then switch
  - [~] New swipe: the native fix — TOP priority @swipe-agent
  - [ ] Verify the new swipe via ?swipe=native, then switch your flag
- Lane A · chat bar (owns DebugChat bar area, MicButton, tap-gesture, float-lines) @bar-agent
  ≈ doing: 多管齐下 · next: 静候佳音
  ≈en doing: Several fixes at once · next: Waiting on your OK
  - [~] Unified bar preview: bar + tree button + 2 columns + floating lines + frontier lines → preview on your phone
  - [~] Minimized float fix
        hot-loaded, ships with the bar
  - [~] Unread badge fix
        hot-loaded, ships with the bar
  - [ ] (!) OK the bar preview @owner
  - [ ] Ship the bar after your OK
  - [ ] Mic stays on after a page refresh (needs your description of the bug)
- Lane B · chat protocol + log lines (owns wire.ts, hub debug.ts, eval.ts, log rendering, Avatar) @protocol-agent
  ≈ done: 水到渠成 · doing: 待君定夺
  ≈en done: Landed cleanly · doing: Your call awaits
  - [x] Avatars #298 (done 2026-10-30)
  - [x] Node paths on messages, @addressing #303 (done 2026-10-30)
  - [ ] (!) Node grants: main-only vs common ancestor — decide @owner
- Lane C · state tree (owns state-tree.ts, StateTree, docs/state-tree.md, /api/dev/state-tree) @tree-agent
  ≈ doing: 稳扎稳打 · next: 来日方长
  ≈en doing: Steady build · next: Later, live
  - [~] State-tree MVP: chat menu + /dev/roadmap, frontier, ≈ summaries, hot data (#304)
  - [ ] (!) Frontier tap: expand vs jump — decide @owner
  - [ ] Live feed (parked branch feat/live-roadmap; resume after the MVP)
- Lane G · rename (owns the user-facing chat strings) @rename-agent
  ≈ doing: 名正言顺
  ≈en doing: Names set right
  - [~] Rename: "debug" out of the UI, 16 locales (#301) — re-merging after conflicts
- Lane D · roadmap data (owns dev/roadmap/items.ts) @roadmap-agent
  ≈ doing: 推陈出新
  ≈en doing: Out with the old
  - [~] Refresh shipped/doing/deciding/ideas → PR for your review
- Lane F · liagent release (owns snolab/liagent main, agent-yes pin) @main-lane
  ≈ doing: 待君定夺 · next: 万事俱备
  ≈en doing: Your call awaits · next: All set to release
  - [ ] (!) Merge agent-yes #527 @owner
  - [ ] (!) Review snolab/liagent#1 and snolab/liagent#2 @owner
  - [ ] liagent #1 and #2 → v0.1.2 + bump the agent-yes pin
- Merge integration @main-lane
  ≈ next: 合而为一
  ≈en next: Bring it together
  - [ ] Merge lanes A+B+C in DebugChat (after each lane's PR)
- Your decisions (no code waits on them unless noted) @owner
  ≈ doing: 待君定夺
  ≈en doing: Your call awaits
  - [ ] (!) Review PR #302
  - [ ] (!) Status-bar colour A/B #279
  - [ ] (!) Playwright QA plan — go/no-go
  - [ ] (!) Auto-start supervisor — go/no-go
  - [ ] (!) Stripe secrets + Dashboard (payments; details below)
- Shipped 2026-10-30 (any order) @main-lane
  ≈ done: 捷报频传
  ≈en done: Wins keep coming
  - [x] Embed mode for overlay iframes (#300) (done 2026-10-30)
  - [x] shot.ts device screenshots (#296) (done 2026-10-30)
  - [x] Natural iOS voices (Tingting/Kyoko/Samantha) (#297) (done 2026-10-30)

Critical path: swipe fix → verify on ?swipe=native → switch the flag; bar → your OK → ship; liagent reviews → v0.1.2 + pin.

## @owner — your to-do
≈ doing: 待君定夺
≈en doing: Your call awaits
- [ ] (!) Add a v* tag ruleset on snolab/liagent (block update/delete) @owner
- [ ] (later) npm login / trusted publishing for liagent @owner
- Payments (Pro passes) — not live yet: no Stripe secrets on the Worker (any order) @owner
  - [ ] (!) Stripe: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET
        → bunx wrangler secret put STRIPE_SECRET_KEY
        → bunx wrangler secret put STRIPE_WEBHOOK_SECRET
  - [ ] (!) Stripe Dashboard: enable Alipay + WeChat Pay
  - [ ] (!) Stripe Dashboard: webhook → https://lianki.com/api/payments/stripe-webhook
        (checkout.session.completed, checkout.session.async_payment_succeeded)
  - [ ] (!) Before live keys: 特定商取引法 page, terms, privacy policy
  - [ ] (!) Your offline paperwork for live payments (see docs/payments.md)
  - [ ] (!) Invite cap: YEARLY_CAP_DAYS = 365 is provisional — confirm
  - [ ] Known gap: refunds have no UI (Dashboard + shorten proEndsAt by hand) @main-lane
  - [ ] Known gap: WeChat Pay shows a QR on phones; fails in WeChat's in-app browser @main-lane

## /words
≈ done: 精益求精
≈en done: Polished again
- [x] Audio prefetch; tap reads word → meaning → example (#291); example first since 2026-11-03: word → example → meaning
- [x] Glass toolbar + help, tablet glass nav, sleeping tray, 80% over-scroll (#293) (done 2026-10-30)
- [x] Faded "back" slip stays opaque (#294)
- [x] iOS glass: first card under the toolbar; labels behind the card; page-scroll lock (#299) (done 2026-10-30T01:12)
- [x] Bamboo-slip prototype (/proto/slip.html): deleted (owner, 2026-11-10)
- [ ] Owner's session spec of 2026-11-03: tall slips, fixed window, review-first, familiar bank, voice commands — [words-session-spec.md](words-session-spec.md) @main-lane

## Learning Partner (chat)
≈ done: 声情并茂
≈en done: Voice comes alive
- [x] Hands-free voice, read-aloud queue, barge-in with ducking (#289, #292) (done 2026-10-30)
- [x] Mic counts as focus (#295)

## Dev tools
- [ ] Iframe-overlay previews vs islands — decide @main-lane

## Later (after this tree works)
≈ next: 来日方长
≈en next: Plenty of time ahead
- Live updates over WebSocket, agents reporting progress
- Node addressing, subtree scopes, grants
- Your to-do list derived automatically from "(!)" items
