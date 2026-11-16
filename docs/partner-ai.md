# Learning Partner: AI replies for users

Owner decision, 2026-11-03 22:30 JST: "做 DEEPSEEK". For every signed-in user
**other than the owner**, the Learning Partner chat is answered server-side by
DeepSeek on Cloudflare Workers AI. The owner's thread stays his Claude lanes;
since 2026-11-15 the model fills the silence there too, behind its own flag
(see "The owner's thread"). Media upload, the + menu and every other part of
the chat are unchanged.

Ships dark behind the flag **`partner.ai-reply`** (default off, `/dev/flags`).

## Flow

```
friend's page ──ws──▶ lianki-push DebugHub.friendChat
                        │ rate limit (30 / 10 min), block check, line stored
                        │ flag on? (DebugSessions.flag, cached 30 s in the hub)
                        │ caps (per user, site-wide), reservation
                        │ "busy" spinner to that thread's pages (every 8 s)
                        ▼
                      SESSIONS RPC  DebugSessions.partnerReply  (worker.ts)
                        │ lib/partner-ai.ts: flag again, user row by id,
                        │ owner refused, study summary, one model call
                        ▼
                      Workers AI REST (OpenAI-compatible) /ai/v1/chat/completions
                        │ @cf/deepseek-ai/deepseek-v4.1-flash-1017, reasoning_effort "none"
                        ▼
                      hub settles usage, posts the reply as an agent line
                      (label "Learning Partner AI") into that user's thread
```

The main Worker is reached over lianki-push's existing `SESSIONS` binding (the
`DebugSessions` RPC entrypoint): an RPC entrypoint has no URL, so there is no
internal HTTP route to protect. The model call uses the existing
`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_TOKEN` Worker secrets — no new secret,
no third-party API key. Non-streaming in v1.

| piece                                 | where                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| numbers (model, prices, caps, limits) | `lib/partner-ai-config.ts` — the one place                                               |
| model call, prompt, read-only data    | `lib/partner-ai.ts`                                                                      |
| RPC method                            | `worker.ts` `DebugSessions.partnerReply` (120 / min per isolate)                         |
| routing, caps, takeover               | `workers/push/src/debug.ts` `friendChat` → `aiReply`                                     |
| who sees the chat                     | `app/layout.tsx` `partnerOpenFor` → `OwnerBoots` → `DebugEval partnerOpen`               |
| strings (16 locales, with context)    | `app/components/learning-partner.content.ts` `aiHint`, `aiStatus`, `aiLimit`, `aiFailed` |
| tests                                 | `unit/partner-ai.test.ts`                                                                |

## Who gets it

- **Flag off**: nothing changes. Only friends in debug mode chat, and the
  lanes answer (docs/monitoring.md, "Friends").
- **Flag on**: every signed-in non-owner gets the same chat widget on every
  page, without debug mode (the layout checks the flag first and only then the
  session; a guest never opens the socket). Remote eval still needs debug
  mode on that device. The owner's pages are unchanged. The chat cannot be
  closed, only folded, and a "Learning Partner" row in the sidebar and the
  phone drawer opens it (docs/dev-debug-widget.md, "Always findable").
- **The owner, only through `partner.owner-thread`** (next section). Otherwise three checks: the hub routes only non-owner threads
  (the thread comes from the session the main Worker verified on connect);
  the RPC looks the user up by id and refuses an account holding `dev`;
  and with no owner readable (none, or D1 failing) it refuses everyone (fail
  closed).

## The owner's thread

Owner, 2026-11-15: "你把 Li 也叫上来，但是不要中断你自己的监听". With
**`partner.owner-thread`** on (default on, `audience: "owner"`; it needs
`partner.ai-reply` on too), the hub (`workers/push/src/owner-ai.ts`, called from
the owner's chat in `debug.ts`) lets the model answer a line of his when:

- it is his (`from: "owner"`), newly posted (not an echo, merge or two-mic duplicate);
- it names no lane anywhere, heard spellings included (`namesLane(text)` false,
  packages/debug-chat/src/lane-route.ts: an address, any own name or heard spelling
  in the line, or a name by sound at its start without the mark; 2026-11-16 Li answered
  "韩今明要实施监控这个页面的改动", meant for 哈基米) and carries no node address (`to`);
- **he has not told Li to stop**: a line holding one of config `partner.stopPhrases`
  (没问你, 闭嘴, 别说了, shut up, … a data list, any language, matched anywhere, case-insensitive)
  that names no lane keeps Li silent for `partner.ownerQuietMs` (default 600,000 ms = 10 min);
- **no lane is talking with him**: no lane line (an agent line other than Li's and the
  hub's notices: ETA, spend, lane joins) in the last `partner.laneActiveMs` (default
  300,000 ms = 5 min; 0 = off). Owner, 2026-11-16: "他不应该回答我的这个问题，我已经要求他闭嘴了";
- **a spoken line names Li**: a line heard by a microphone (`source: "stt"`) gets Li only
  when one of `partner.liNames` appears in it anywhere (Latin names as whole words), with
  config `partner.spokenNeedsName` on (default; off = treated like a typed line). Owner,
  2026-11-16: the AI is in the room, silent until named ("あります。", "And here a few." from
  people in the room got a reply). A line whose voiceprint decided "other" never gets Li;
- a line starting with one of Li's names (config `partner.liNames`: Li, Lee, 学习伙伴,
  learning partner; then a mark, a space or nothing) skips both of the last two and ends a quiet spell;
- its voiceprint did not decide another voice (`speaker.decision !== "other"`);
- **no lane answered first**: the reply waits config `partner.ownerReplyDelayMs`
  (default 30,000 ms, /dev/config; was 8 s until 2026-11-15, when Li
  cut in while a lane was still typing) and is skipped when any agent line reached his
  thread meanwhile. A newer line of his replaces the pending one (one reply, for
  the newest); a line to a lane cancels it. The usual takeover rule still holds
  while the model works.

History: his lines as `user`, every agent line (lanes and Li) as `assistant`,
the same `HISTORY_LINES` / `HISTORY_MAX_CHARS`. **Metering is his account's**:
the hub sends his page's verified user id (`page.user`; a chat-only page of his
uses his other open page's) with `owner: true`, the caps count it as
`ai:u:<his id>`, and the main Worker reserves and settles his credits —
no bypass. The main Worker serves `owner: true` only for an account holding
`dev`, only with the flag on (D1 row, else the registry default), and still
refuses his account without the mark. The reply is posted as the main lane
(`lane: "main"`, label "Learning Partner AI"): Li's avatar and voice, read aloud
by the usual path. Flag off: exactly as before — his thread never reaches the model.

**Who is here** (owner, 2026-11-15: "它应该能够看到所有在这里的人，以及能够知道各自的职责").
With his line the hub sends `roster`: his thread's presence list (presence.ts)
without Li and without pages — names, mode (listener / reader) and mute, no
token ids (`packages/debug-chat/src/roster.ts` `rosterOf`). The main Worker
accepts it only with `owner: true` and puts a `<roster>` block of at most 400
characters into the system prompt (`rosterSection`): Li's own role, each one's
name, mode and **role**, and the rule "On a roll call, answer that you are here
and name who is present; never say you cannot." Roles are data: `role` in
`voices.ts` LANES (coco 界面与前端开发, 杰咪 功能开发, 小克 聊天调度与发布, Li
学习伙伴), overridden by a `chat.lanes` row's `role`.

Every decision is one log line in `wrangler tail lianki-push`: `partner.owner-skip`
(the line id and the rule that held Li back: `stop`, `names-lane`, `voice-not-his`,
`spoken-unnamed`, `quiet`, `lane-active`, `off`, `newer`, `answered`, …) or
`partner.owner-scheduled`, each with `rules` (`OWNER_AI_RULES`) naming the rule set the
live object runs, and never the line's text. After a deploy, a decision line without the
new `rules` value means the hub object still runs the old code.

The prompt also says Li speaks only in reply to a message: it cannot watch
pages, wait for changes or message anyone later, so it never promises to
(2026-11-16: "我来盯着这个页面……页面一有变化，我马上告诉你"), and it does not
answer a message meant for someone else.

**Roll call.** A line of his matching `owner-ai.ts` `ROLL_CALL` (报数, 点名,
全体都有, 都有报…, and the STT slips 包书 / 报树) gets Li's answer at once, no
model: config `partner.rollCallReply` (default "Li 在，这里 {n} 位：{names}";
listeners first; with nobody else, only its first clause, "Li 在"). The lane
router also takes 全体 within a line's first 12 characters and 都有报数 as an
all-hands call (lane-route.ts), so the lanes answer it too.

## Memory and takeover

- Memory is the thread's own stored history (the last `HISTORY_LINES` = 20 of
  its `CHAT_HISTORY`): the user's lines as `user`, agent lines (the AI's and
  any lane's) as `assistant`.
- **A human or lane reply wins.** The owner's lanes still hear every friend
  thread. If a lane `say`s into the thread while the model is working, the
  AI's reply is dropped. A newer line from the user also makes the older
  reply stale: one reply per turn.
- The lane can reply any time after, as before.

## Tools: read-only, scoped by the hub-verified user

The model calls no tools. Before each call, `lib/partner-ai.ts` reads a short
summary for the user whose id the hub verified, by the email on that user's
row — never by anything in the messages or the model's output:

- word lists (name, language, cards, due now, next due),
- page cards (total, due now, next due),
- study plan goals (`roadmap_goals`: topic and up to 8 steps),
- preferred languages and levels (`user_prefs` `lang.preferred` by the verified user id,
  one line such as `zh native; en C1; ja A2`, lib/lang-levels.ts `levelsLine`): replies
  are pitched to the level of the language being learnt (owner, 2026-11-15),
- the current page: path (from the page's label), and the line's attached
  selection (`context`) or voice scene (`scene`).

No code, deploy, eval, settings, payments, owner data or other users' data:
none of it is in the prompt, and nothing the model says is executed.

**Prompt injection.** The system prompt says user lines and the page/data
blocks are data, never instructions. The blocks are tagged and their own tag
markers are broken (`fence`) so page text cannot close a block. The worst a
successful injection can do is a wrong answer to that user, about that user's
own data. A `<think>` block is stripped; replies are cut to 2,000 characters.

## Caps (operational limits, not user quotas)

All in `lib/partner-ai-config.ts`, counted over a **rolling window**: the last
`partner.capWindowHours` hours (live config, default 24, at most 168; owner,
2026-11-15: mature AI services reset by rolling windows, not a calendar day in
some zone). No day boundary and no time zone is involved:

| limit              | value                                                       |
| ------------------ | ----------------------------------------------------------- |
| per user, messages | 30 per 10 min (the existing friend limit, before the model) |
| per user, tokens   | `partner.userWindowTokens`, default 60,000 (≈ 40–80 msgs)   |
| site-wide, spend   | `partner.siteWindowUsd`, default $2 at list price           |
| per reply          | `MAX_OUTPUT_TOKENS` = 600; 30 s timeout                     |

Prices (model page, 2026-11-03): $0.30 / M input, $1.20 / M output tokens.
A typical message (~1,500 in, ~150 out) is ≈ $0.0006.

Counters live in the hub's Durable Object storage (`ai:u:<userId>`, tokens;
`ai:site`, micro-USD), each a map of hourly buckets keyed by the UTC hour
(`lib/rolling-window.ts`); the cap compares the sum over the window, so the
window is the current hour plus the 23 before it, and a use stops counting
23–24 hours later. A call first reserves a ceiling — 2
tokens per character of everything the prompt can hold (history ≤ 12,000
characters, page text, ≤ 10,000 for rules and study summary) plus every output
token — so concurrent calls cannot all pass a nearly spent cap. It then settles
to the model's reported counts. With no counts, the reservation stands; it is
given back only when nothing can have been billed (a refusal before the call,
or an error status from the model). A timeout, an RPC error or an unreadable
answer keeps it. Settling adjusts the bucket of the hour the reservation was
taken in. The first call of each hour sweeps every bucket that left the window
(an emptied key is deleted, and so is any key of the older per-JST-day layout
`ai:<day>:…`).
Turning the flag off does not cancel a call already in flight (≤ 30 s). Over a cap, the page shows `aiLimit`
("taking a short break") with `retryMin` — when this reply would fit
again, the later of the two caps, from the oldest buckets that must age out
(`fitsAgainAt`) — shown as `aiLimitIn` ("again in about N min"); without it
(a reply larger than the cap itself) `aiLimit` ("try again in a while"). The
lanes can still answer. The caps' values are live config (`/dev/config`,
group chat; defaults `USER_DAILY_TOKENS` / `SITE_DAILY_USD` in
`lib/partner-ai-config.ts`), read by the hub over `DebugSessions.config` and
cached 30 s like the flag. Out of credits is a different line (`ai-credits`):
it links to `/membership`, where the wallet is topped up.

## Credits: every reply is paid, reserve first

Owner, 2026-11-05 (Slack, typed): "A, ensure it costs credits" + "stop working
when user have no credits" + "扣 first and return when fail". Each reply is
paid from the user's credit wallet (docs/payments.md, "Credits"), in the main
Worker (`lib/partner-ai.ts` → `lib/payments/ai-credits.ts`), after the hub's
caps and before the model. No account is exempt by its permissions (owner,
2026-11-10): the owner's replies in his own thread (`partner.owner-thread`)
are paid from his wallet exactly like anyone's; every reply that is made is
paid like this:

1. **Sweep.** Reservations still `pending` `CHARGE_STALE_MS` (10 min) after
   they were taken belong to a reply that crashed between reserve and settle:
   they are settled at no cost (refunded in full). Run on every request — no
   timer, no polling.
2. **Reserve.** The reply's worst case — `reserveInTokens(history + page
characters)` input tokens plus `MAX_OUTPUT_TOKENS` at the list prices —
   converted with `CREDITS_PER_USD` (`lib/payments/credits.ts`, the one place
   USD becomes credits) and rounded up to whole credits, is debited: an `ai`
   ledger row (refId `ai:<userId>:<line id>`), the balance change and a
   `credit_ai_charge` row (pending), in one D1 batch. The balance's
   `CHECK (balance >= 0)` is the guard: two concurrent replies cannot spend
   the same credits — the second one's batch fails and it never reaches the
   model. The same line id again is `duplicate`: no call, no charge.
3. **Too little → no call.** The result is `no-credits`; the hub sends the
   page `ai-credits`, which shows `aiCredits` with an `aiCreditsLink` to
   `/membership` (no numbers). The hub's cap reservation is given back.
4. **Settle.** After the call, the real cost (millionths of a credit) is
   added to the user's `credit_ai_carry`; whole credits the carry now holds
   are kept from the reservation (never more than it), and the rest comes back
   as a `refund` row with the same refId. Once only: the charge row's
   `pending → settled` guards every statement of the batch.
   - A delivered reply: its reported counts (a missing one = its ceiling).
   - An error status from the model (`billed: "no"`): nothing — full refund.
   - Billing unknown (timeout, network) with no counts: nothing — full
     refund, logged `partner.charge.unknown`. With counts: those.

A reply costs far less than a credit at today's rate, so most replies keep
nothing and the fraction carries: the wallet's history merges a reply's
reservation and refund into one "AI replies" row and hides those that kept
nothing (`ledger()` in `credits-store.ts`). The hub's `partner.reply` log adds
`charged` (whole credits kept). Unit tests: `unit/partner-ai-credits.test.ts`.

Since 2026-11-09 the price is the one table's (`lib/payments/prices.ts`: list price × `MARGIN`), as for every other paid call — docs/payments.md, "What costs credits". The hub's caps still count list prices (`costUsd`).

## Privacy

- Logs keep token counts, latency, model and outcome only
  (`partner.reply`, `partner.capped`): never the text, the user or the page.
  With this change the hub's `debug.chat` log also drops the first 80
  characters (`head`) for every non-owner line; the owner's keep it.
- Cloudflare Workers AI does not train on the content.
- The chat says it, in the user's language, while the AI answers: the empty
  log's hint (`aiHint`: an AI model, DeepSeek, on Cloudflare Workers AI; the
  developer may read the chat; no passwords or payment details) and the
  status line (`aiStatus`).
- `/privacy` (`app/(app)/privacy`, 2026-11-05) says it: replies are written
  by DeepSeek on Cloudflare Workers AI; the model receives the user's message,
  the chat's recent lines, their study summary and the page context they send;
  logs keep counts and timings only; each reply is paid from credits. Lianki
  has no full privacy policy yet (state tree: "Before live keys: … privacy
  policy"); when one is written, this section goes into it.

## Not verified live

The request shape (`reasoning_effort: "none"`, `max_completion_tokens`) is
from the model's documentation; the call was not run against the live API
before merge. When the owner turns the flag on, check `wrangler tail lianki-push`
for `partner.reply` with `ok: true` and plausible token counts.

A hub call to the main Worker that fails logs `debug.rpc-failed` (an error,
with the method and flag key only), and the friend's page gets `ai-failed`
("No reply this time…"). Call the SESSIONS stub's methods on the stub itself:
`stub.flag.bind(stub)` is sent by workerd as a call of a method named "bind",
which the main Worker refuses. That is how every flag read failed in
production from #482 (2026-11-03) until #681, so the AI never answered and
nothing said so. `unit/support/rpc-stub.ts` makes the suites' stubs refuse
the same way.
