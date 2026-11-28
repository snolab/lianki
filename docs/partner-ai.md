# Learning Partner: AI replies for users

The Learning Partner is answered server-side by DeepSeek on Cloudflare
Workers AI. The shared flow below treats an account with development grants
like any other account; the legacy owner-specific rules remain only while
the new switch is off. Media upload and the + menu are unchanged.

Ships dark behind the flag **`partner.ai-reply`** (default off, `/dev/flags`).

## Shared conversation flow

2026-11-27: **`partner.standard-flow`**, default off, also needs
`partner.ai-reply`. The same `PartnerTurn` scheduler handles every account:
typed messages start a turn immediately; speech waits for `partner.turnPauseMs`
(default 8 seconds), bounded by 30 seconds or 12 lines. A newer line supersedes
an unfinished model result and keeps its source references in the next batch.
Known other/unknown voiceprint results keep their existing exclusion from
automatic replies. Speech also honors `partner.spokenNeedsName` (default true):
an address to Li (`partner.liNames`) or another assistant opens a speech turn,
and follow-up fragments within its pending pause window join that turn without
repeating the name. Neither a microphone left active nor `wakeReason: mic-on`
opens a turn. A device without voiceprint support can explicitly address an
assistant, but missing voiceprint data never enables an unaddressed new turn,
even with `spokenNeedsName` off. That option permits unaddressed starts only
with a verified `me` decision. Explicit `unknown`/`other` decisions cannot be
overridden by a name or an open turn. Typed messages are unaffected. Skips log
`partner.standard-skip` with a reason only; original messages still reach their
existing listeners. This does not turn on a microphone or change permissions.

**No speaker priority or waiting barrier.** The old rules that give development
assistants priority, reject engineering questions, require Li's name or skip a
reply because another assistant answered do not apply to this mode. Original
messages still reach listeners immediately. Any assistant may listen, answer
directly or remain silent; a model error, timeout, missing credits or cap never
holds the original message back. There is no new execution queue or automatic
tool authorization.

One model call produces the visible reply and an advisory brief. A `<handoff>`
section is parsed off before display; malformed summaries fall back to the
original text. The hub stamps `coordination` on its own reply, with `sources`
(original ids and bounded text), an advisory `summary`, deterministic `targets`
from addresses in the original text, and `fromSeq`/`throughSeq` when available.
The model cannot choose the source ids or recipients. This is a context update,
not another user instruction; assistants compare source ids with work already
received. The original messages remain authoritative and can be read through
the existing token `op:read` / `lianki_chat_read` range (`afterSeq = fromSeq - 1`,
`throughSeq`). These references cover the hub's retained history, not permanent
retention of raw speech.

The public token WebSocket, `lianki_chat_wait`, `lianki_chat_read`, and CLI
`chat listen` expose the same metadata within the authenticated thread. The CLI
bridge and `lane-listen --everyone` label it as an advisory context update and
keep the original user/agent roles. No separate MCP subscription API is added.

All accounts use the existing credit reservation, settlement and caps. The
main Worker rechecks both switches; development grants no longer exclude a
normal reply in this mode. Only an account with a current `dev` permission
gets a bounded, read-only snapshot of active state-tree tasks. That data comes
from the service binding after the permission check, never from a request's
claimed role or progress field. Chat-only third-party pages do not get it.
Failure to read the state tree leaves the reply without that context.

For deployment: ship the default-off code and verify the normal gates first.
Changing current listeners is a separate operational handover: use each
assistant's own existing token and the standard CLI, never pairing or an eval
grant for chat. Do not stop another assistant's running listener as part of a
code update. The legacy flow below remains a rollback while the switch is off.

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
| who said what (history, reply tags)   | `lib/partner-lines.ts`                                                                   |
| tests                                 | `unit/partner-ai.test.ts`, `unit/partner-lines.test.ts`                                  |

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
- **A site's thread from the pill** (flag `ext.pill-chat-per-origin`,
  docs/userscript-li-chat.md "Per-site threads"): `<base>~<hash>`, its own
  history and prompt window (`ai:win:<thread>`), so Li on one site reads none
  of the others. Metered and billed to the base account as its own thread;
  in the owner's site threads the request carries `owner: true` as in his.

## The owner's thread (legacy flow)

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
- **it names no other agent and is no dev/ops request** (owner, 2026-11-26: "知道有别的
  agent 在就先安静，让能处理的 agent 去处理"): config `partner.otherAgentNames` (吉米, claude,
  mimiai, … on top of the lane table) and `partner.devWords` (部署, 代码, 计费, Cloudflare,
  bug, PR, …), Latin entries as whole words. Even addressed to Li, such a line is the
  agents': Li only polishes it (the hub's auto-polish), skip reasons `names-agent` /
  `dev-request`. 2026-11-26: a line naming 吉米 about a voice-sync experiment and
  Cloudflare billing got a reply listing what Li does not do; 吉米 was in no list;
- **it is about study**, unless it starts with Li's name: config `partner.studyWords`
  (今日目标, 单词, 复习, 到期, 语法, words, due, review, …). Any other line is polished
  only (`off-topic`);
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
and name who is present. A line for one of them is theirs to answer." Roles are data: `role` in
`voices.ts` LANES (coco 界面与前端开发, 杰咪 功能开发, 小克 聊天调度与发布, Li
学习伙伴), overridden by a `chat.lanes` row's `role`.

Every decision is one log line in `wrangler tail lianki-push`: `partner.owner-skip`
(the line id and the rule that held Li back: `stop`, `names-lane`, `voice-not-his`,
`spoken-unnamed`, `quiet`, `lane-active`, `off`, `newer`, `answered`, …) or
`partner.owner-scheduled`, each with `rules` (`OWNER_AI_RULES`) naming the rule set the
live object runs, and never the line's text. After a deploy, a decision line without the
new `rules` value means the hub object still runs the old code.

The prompt also says Li speaks only in reply to a message, so it never
promises to watch pages or follow up later (2026-11-16: "我来盯着这个页面……页面一有
变化，我马上告诉你"), and it does not answer a message meant for someone else.

**Never "can't"** (owner rule for every agent, 2026-11-26). Li's rules are config
`partner.systemPrompt` (default `PARTNER_SYSTEM_PROMPT` in lib/partner-ai-config.ts,
at most 6,000 characters). They tell Li it is one member of a shared chat (the
developer and his agents read it; the roster says who is here), that it never lists its
limits or turns a request down, and that outside language study it answers with the
closest workable option or names who handles it, in one short line.
`unit/partner-no-cant.test.ts` holds the default, the polish rule and the roster block to
no refusal phrasing (cannot, 不能, 做不到, 不是我的活, …).

**Speaking as itself** (`lib/partner-lines.ts`). Li never writes as another
member or offers to build things (2026-11-17: an unaddressed request for a
userscript got "【claude】Happy to build it… M1 (today)"). Three layers: lane
lines reach the model attributed, as `user` lines "(agent coco said: …)" —
not as its own `assistant` lines, which it had been continuing in their
voice; the prompt says it speaks only as itself, never writes a name tag and
does not write code, build features or run tasks (the developer reads this
chat); and `cleanReply` strips any leading speaker tag from its reply: every
`【…】` (in this chat a leading 【name】 is always a speaker tag), and `[name]`
/ `name:` when the name is a lane's id, name or alias or Li's own.

**Roll call.** A line of his matching `owner-ai.ts` `ROLL_CALL` (报数, 点名,
全体都有, 都有报…, and the STT slips 包书 / 报树) gets Li's answer at once, no
model: config `partner.rollCallReply` (default "Li 在，这里 {n} 位：{names}";
listeners first; with nobody else, only its first clause, "Li 在"). The lane
router also takes 全体 within a line's first 12 characters and 都有报数 as an
all-hands call (lane-route.ts), so the lanes answer it too.

## Prompt caching and the polish inside Li's call (2026-11-25)

Owner, 2026-11-25: "polish step should be with lianki learning partner respond
together so it reads whole chat"; "can u ensure the history stable? because if
it changes any byte, we cost again on cache miss"; "摘要可以在过程中追加修改之类，
换新 checkpoint 的时候合并（类似 nedb 的设计）". Workers AI prefix caching
(developers.cloudflare.com/workers-ai/features/prompt-caching) matches exact
bytes from the start of the prompt, on the instance the `x-session-affinity`
header pins, and reports cached tokens in `usage`.

**Done (the automatic polish, lib/chat-polish.ts).** It sends
`x-session-affinity` = `lib/ai-affinity.ts` `chatAffinity(userId, "owner")`, a
SHA-256 hash (`ses_…`), never the raw id. Its system prompt is static (no date,
no per-call data). Its payload leads with the context, so more leading bytes
repeat. It reads the earlier lines as read-only context
(docs/dev-debug-widget.md, "Automatic polish"). `usage` `tokensIn` /
`cachedIn` (`prompt_tokens_details.cached_tokens`) go into the hub's
`debug.auto-polish` log, so the hit rate shows in `wrangler tail lianki-push`.
Billing stays at the list input price for now.

**Li's prompt in cache order (flag `partner.stable-prompt`, default on, for
everyone; off = the old order, exactly as before).** Until 2026-11-25
`buildMessages` put the roster, `user_data` (with `today` and due counts) and
the page block into the one system message _before_ the history, and the
history was a sliding window of current texts, so no two calls shared more
than the rules. Now:

1. **Order.** The static system message comes first: `SYSTEM_PROMPT`, plus in
   his thread `POLISH_SECTION_RULE`, which is there whether or not the call has
   lines to polish. It holds no date and no per-call data. Then the frozen
   history. Then one last `system` message with the per-call parts: roster,
   `user_data` (with `today`), page, `polish_lines`. The rules and the data
   are the same as before; only the order changed (snapshot test).
2. **Frozen history** (`lib/partner-window.ts`, kept by the hub as
   `ai:win:<thread>`). A line enters the window once, as it read then, and
   never changes there. A line changed later (a polish, a merge) gets an edit
   entry appended, `(correction: the earlier line "…" now reads: …)`. Within a
   call, edits come first and then the new lines, so his newest line stays last.
3. **Checkpoints.** Over the bound (`HISTORY_LINES` entries or
   `HISTORY_MAX_CHARS` characters), a new window starts from the newest lines
   within config `partner.checkpointKeepPct` (50) percent of it. Lines before a
   checkpoint never come back. That is one cache miss per checkpoint. Right
   after a checkpoint Li reads at least half the old window, not all of it:
   that is the price of the cache.
4. **Polish inside Li's reply.** In his thread the hub sends his newest
   spoken run that no polish has touched (`autoPolishPick`, flags
   `voice.auto-polish` and `stt.polish`) as `polish`. Li answers and adds
   `<polish>{"lines":[{"id","text"}]}</polish>` on its last line.
   `splitPolish` takes the section off the reply and holds it to the ids
   sent (each once, changed, at most `PARTNER_POLISH_LINE_CHARS`). The hub
   applies it through `polishLine`, stamped `by: "auto"` (raw kept for undo,
   read-back), only to a line that still reads as sent and that nothing
   polished meanwhile. So a line is never polished twice: the hub's own polish
   (1.5 s after he pauses) usually lands first, and then the line is not
   offered again. A missing, malformed or unclosed section is dropped, and the
   reply still posts. It is the same one call and one charge, and the lines
   count toward the reservation. Logged `partner.polish` (counts only).
5. **Cache pins and counts.** Every Li call sends `x-session-affinity`
   (`chatAffinity(userId, "owner" | "friend")`, the same id as the polish in
   his thread). `partner.reply` logs `stable`, `cachedIn` (Workers AI's cached
   prompt tokens) and `polishLines`.

Measured (`unit/partner-stable-prompt.test.ts`, a 60-line conversation with
Li answering 30 lines, ~120-character lines, every fifth line of his polished
later, the page and due counts changing every call):

| order  | whole prompt repeated | after the rules                        | misses                                                         |
| ------ | --------------------- | -------------------------------------- | -------------------------------------------------------------- |
| stable | 85%                   | 57% (the rest is each call's new tail) | 5 of 29: the checkpoints; 92% of each previous prefix repeated |
| old    | 60%                   | 0%                                     | 29 of 29                                                       |

**Not built yet: the memory summary (nedb style).** Inside a checkpoint the
summary would be an append-only log after the history, never rewritten. At a
new checkpoint the old summary and its entries, later entries overriding
earlier ones, would be compacted into one fresh summary at the top of the new
window. The standalone polish (`lib/chat-polish.ts`) still has its own
`POLISH_PROMPT` system message. Sharing Li's prefix too would need it to send
Li's static prompt and window, a step for later.

## Memory and takeover

- Memory is the thread's own stored history (the last `HISTORY_LINES` = 20 of
  its `CHAT_HISTORY`; with `partner.stable-prompt`, the frozen window above): the user's lines as `user`, the AI's own as
  `assistant`, any other agent line (a lane, a hub notice) as an attributed
  `user` line, "(agent NAME said: …)" (`lib/partner-lines.ts`).
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
