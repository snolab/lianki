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
-->

# Lianki — state tree (draft, 2026-10-30)

Legend: [ ] open · [~] in progress · [!] blocked · [x] done · (!) waits on you · → command or link

≈ done: 捷报频传 · doing: 多线并进 · next: 蓄势待发
≈en done: Wins keep coming · doing: Many fronts at once · next: Ready to go

## Plan — everything in parallel (2026-10-30)
≈ done: 捷报频传 · doing: 多线并进 · next: 蓄势待发
≈en done: Wins keep coming · doing: Many fronts at once · next: Ready to go

- Lane A · chat bar (owns DebugChat bar area, MicButton, tap-gesture, float-lines) @bar-agent
  - [~] Unified bar + tree button + 2 columns + floating lines + frontier lines (~30 min) → preview on your phone
  - [ ] (!) Your OK on the preview @owner
  - [ ] Mic stays on after a page refresh (~25 min; needs your description of the bug)
- Lane B · chat protocol + log lines (owns wire.ts, hub debug.ts, eval.ts, log rendering, Avatar) @protocol-agent
  - [~] Avatars #298: resolve the merge conflict (~15 min)
  - [ ] Node paths on messages, @node addressing, agent↔agent scope (~60 min, after #298)
- Lane C · state tree (owns state-tree.ts, StateTree, docs/state-tree.md, /api/dev/state-tree) @tree-agent
  - [~] Text tree MVP in the chat menu + /dev/roadmap, frontier, ≈ summaries (~30 min)
  - [ ] Live feed (parked branch feat/live-roadmap; resume after MVP, ~60 min + deploy)
- Lane D · roadmap data (owns dev/roadmap/items.ts) @roadmap-agent
  - [~] Refresh shipped/doing/deciding/ideas (~10 min) → PR for your review
- Lane E · /words (owns WordsClient, words CSS, qa-words, public/proto) @main-lane
  - [ ] Recheck #299 on your iPhone, both swipe modes (~5 min, eval grant)
  - [ ] (!) Confirm deleting public/proto/cords.html @owner
  - [ ] Delete cords.html + its link + QA check (~10 min, after your confirm)
  - [ ] (!) Islands split of /words — decide @owner
- Lane F · liagent release (owns snolab/liagent main, agent-yes pin) @main-lane
  - [ ] (!) Merge agent-yes #527 @owner
  - [ ] (!) Review liagent#1 (avatars) @owner
  - [ ] Merge liagent PRs from lanes B and C, cut v0.1.2, bump the agent-yes pin (~20 min, after B, C and your reviews)
- Merge integration @main-lane
  - [ ] Merge lanes A+B+C in DebugChat (~20 min, after each lane's PR)
- Your decisions (no code waits on them unless noted)
  - [ ] (!) Status-bar colour A/B #279 @owner
  - [ ] (!) Playwright QA plan — go/no-go @owner
  - [ ] (!) Auto-start supervisor — go/no-go @owner
  - [ ] (!) Ship the islands groundwork? @owner
  - [ ] (!) Mixed-language STT test on iPhone @owner
  - [ ] (!) Indonesian name TB vs MB @owner
  - [ ] (!) Stripe secrets + Dashboard (payments) @owner
  - [x] shot.ts screenshots (#296) (done 2026-10-30)
  - [x] Embed mode (#300) (done 2026-10-30)

Critical path: B #298 fix (15) → node paths (60) → integration (20) → liagent v0.1.2 + pin (20) ≈ 115 agent min, plus your merges/reviews.
Lane C live feed: 30 + 60 + deploy ≈ 100 agent min, in parallel.
Total wall-clock: about 2 agent hours, if your decisions don't block a lane.

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
- [x] Glass toolbar + help, tablet glass nav, sleeping tray, 80% over-scroll (#293)
- [x] Faded "back" slip stays opaque (#294)
- [x] iOS: first card under the toolbar; labels behind the card; page-scroll lock (#299) (done 2026-10-30T01:12)
- [ ] Bamboo-slip prototype (/proto/slip.html) vs shipped swipe — decide @main-lane

## Learning Partner (chat)
≈ done: 声情并茂
≈en done: Voice comes alive
- [x] Hands-free voice, read-aloud queue, barge-in with ducking (#289, #292)
- [x] Mic counts as focus (#295)
- [~] Rename: "debug" out of the UI, 16 locales (#301) @main-lane
- [x] Natural iOS voices (Tingting/Kyoko/Samantha) (#297)

## Dev tools
- [ ] Iframe-overlay previews vs islands — decide @main-lane

## Later (after this tree works)
≈ next: 来日方长
≈en next: Plenty of time ahead
- Live updates over WebSocket, agents reporting progress
- Node addressing, subtree scopes, grants
- Your to-do list derived automatically from "(!)" items
