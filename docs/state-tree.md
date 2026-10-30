<!--
The state tree: what is in flight and what waits on the owner. Hand-edited
by the owner and by agents. The plan (lanes) comes first; an item lives in
one place only. The owner reads it in the Learning Partner chat
(menu → Tree) and at the top of /dev/roadmap; the chat's minimized bar shows
its frontier: ✓ the latest done, ▶ in progress, › next. Parser and rules:
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
    bun scripts/dev/progress.ts --agent <you> --path /words/swipe       --task "Native swipe" --status doing --pct 40 --eta 15m
    … --done --pr 310        when it lands
    … --status blocked --note "why"
    … --status waiting-owner --needs "OK the preview" --kind approval
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

  Limits: name 40, task 120, note 280, needs 120; 200 nodes (oldest done
  dropped first); done nodes pruned after 24 h (Durable Object alarm); a
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
  - [ ] (!) Confirm deleting public/proto/cords.html @owner
  - [ ] Delete cords.html + its link + QA check (~10 min, after your confirm)
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
- [x] Audio prefetch; tap reads word → meaning → example (#291)
- [x] Glass toolbar + help, tablet glass nav, sleeping tray, 80% over-scroll (#293) (done 2026-10-30)
- [x] Faded "back" slip stays opaque (#294)
- [x] iOS glass: first card under the toolbar; labels behind the card; page-scroll lock (#299) (done 2026-10-30T01:12)
- [ ] Bamboo-slip prototype (/proto/slip.html) vs shipped swipe — decide @main-lane

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
