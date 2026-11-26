# Li chat from the userscript pill (design stub)

Tree: /ext/li-chat

State-tree node `/ext/li-chat`. Status: **M1 shipped (userscript 2.24.30)**
— the trust gate and the pill's Li entry, owner only. **M2 and M3 built
(userscript 2.24.35)**: the account-scoped Li chat ticket and Share from the
frame's composer, dark for users. M4–M5 open. Flags: **`ext.pill-chat`**
(default off, on for the owner) and **`ext.pill-chat-users`** (default off;
M5). The **security gate** below must pass in full before
`ext.pill-chat-users` is turned on.

## What was built in M2 (account ticket)

| piece                                          | where                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| audience `lianki-li-chat`, `sub` = D1 user id  | `lib/stt-ticket.ts` (`LI_CHAT_TICKET_AUD`, `isTicketSub`)                                 |
| who may open Li, with which ticket             | `lib/pill-chat-route.ts` `pillChatAccess` → `GET /api/ext/pill-chat` `{ on, ticket }`     |
| `POST /api/chat/li-ticket`                     | `lib/li-ticket-route.ts`, `app/api/chat/li-ticket/route.ts`                               |
| hub: verify, route to the account's own thread | `workers/push/src/auth.ts` `liChatTicket`, `index.ts`, `debug.ts` `connectPage` (`embed`) |
| userscript: fetch the ticket lianki.com names  | `src/pill-chat.ts` (`TICKET_PATHS`)                                                       |
| tests                                          | `unit/li-ticket.test.ts`, `unit/pill-chat.test.ts`                                        |

- **Who.** `ext.pill-chat` off: nobody. On: the owner (`isDev`) as before,
  with his partner ticket into his own thread (`ticket: "owner"`). Any other
  signed-in account only while **`ext.pill-chat-users`** is on too
  (`ticket: "account"`). Signed out: off.
- **The route.** `POST /api/chat/li-ticket`: 404 (says nothing) without the
  `x-lianki-userscript: 1` header, unless both flags are on, signed out, or
  for a `dev` account (the owner never gets an account ticket); 429 past
  config `chat.pillTicketsPerMinute` (default 20) per account; 503 without
  `STT_TICKET_KEY`. Session, or a token with `chat:read` + `chat:write`.
  The ticket: `{aud: "lianki-li-chat", sub, jti, iat, exp}`, 60 s, never an email.
- **The hub.** lianki-push takes it only under the partner subprotocol and
  only from origin `https://lianki.com` (the frame; the host page never opens
  the socket itself), burns its jti, drops the cookie and every identity
  header, and forwards it as `user = sub`, `owner = 0`, with the embed
  header. The hub makes it a page in **that account's own thread** with
  `embed: true`: chat / page / replay only, minimal state (no pairing, page
  list or ids), never eval, never counted for an agent's pairing with that
  account (`pairForFriend` ignores embed pages), and a blocked account is
  closed. It can never read or post in another account's or the owner's
  thread: the thread is the ticket's `sub`, nothing the page says.
- **Caps and billing** as for any user's thread (partner-ai.md): unchanged.
- **lianki-push needs a deploy** for M2 (auth.ts, index.ts, debug.ts).

## Per-site threads (flag `ext.pill-chat-per-origin`, default off)

Each website origin gets its own Li thread under the account, so one site's
conversation never mixes with another's and Li's context on one site holds
none of the others. Off (the default): every site is the account's one
thread, exactly as M2. Userscript 2.24.39.

| piece                                                   | where                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| origin check, thread id, site hash (pure)               | `lib/li-thread.ts`                                                                                                     |
| the userscript names the top window's origin            | `src/pill-chat.ts` (`x-lianki-host-origin` on the ticket request)                                                      |
| minting binds it (`ho`, `th` in the signed ticket)      | `lib/li-ticket-route.ts`, `lib/partner-ticket-auth.ts` (`siteBinding`)                                                 |
| the frame reports the parent origin the browser stamped | `embed/frame-protocol.ts` `helloFrom` (`event.origin`), `PartnerFrame.tsx` `?ho=`                                      |
| hub: same origin or refuse; route to the site's thread  | `workers/push/src/auth.ts` `ticketSite`, `index.ts`, `debug.ts` `subThreadFor`                                         |
| his list on lianki.com, open one and chat               | `/chat/sites` (`app/(app)/chat/sites`), `GET /api/chat/sites`, hub `/internal/sub-threads`                             |
| tests                                                   | `unit/li-thread.test.ts`, `unit/pill-chat.test.ts`, `unit/partner-frame.test.ts`, `unit/partner-send-insecure.test.ts` |
| end to end (local Workers, https + plain-http sites)    | `scripts/qa/qa-pill-chat-sites.ts` (suite `pill-chat-sites`)                                                           |

- **Thread id.** `<base>~<hash>`: `base` is the account's own thread
  (`owner`, or the D1 user id), `hash` the first 16 bytes (base64url, 22
  chars) of HMAC-SHA-256(base + "\n" + origin) under a key derived from
  `STT_TICKET_KEY`'s private part (no new secret; rotating that key gives each
  site a new thread, the old lines stay in the history). The id never spells
  the origin, and without the key a guess cannot be tested.
- **Where the origin comes from.** Two sources that must agree, neither one
  the page's say. (1) The userscript's shell reads `location.origin` in its
  own isolated world and sends it as `x-lianki-host-origin` on its
  `GM_xmlhttpRequest` for the ticket (the page cannot touch that request);
  lianki.com accepts only a plain http(s) origin (no path, query, userinfo;
  at most 100 chars) and signs it into the ticket with the hash. (2) The
  frame, on the hello, keeps the browser's `event.origin` (the window that
  posted it) and connects with `?ho=<origin>`. lianki-push takes a site
  ticket only from origin `https://lianki.com` and only when `?ho=` equals
  the ticket's `ho`; anything else is refused before its jti is spent.
- **Refusals.** A ticket for site A in a frame on site B: 403. A ticket of
  another account: its `sub` (and so its base) is its own; the hash is
  signed with it. A lianki.com page asks for a site thread with `?sub=<hash>`:
  only with the flag on and only for a thread the hub already holds under
  **that page's own account** (4404 otherwise). The hub never merges two
  origins under one hash.
- **The thread.** Chat only everywhere (`embed`), as M2. Blocks, the friend
  rate and the friend record go by the account. No lane hears a site
  thread's lines (they go to its pages, Li and the account's history only).
  Li answers with that thread's lines alone (`ai:win:<thread>` is per thread);
  billing and caps are the account's, unchanged; in the owner's site threads
  Li answers as in his own (`owner: true`, with his account id).
- **Privacy.** The origin is kept only as an origin, in the hub's record
  beside the thread (`subt:<thread>`: origin, first and last visit) for his
  list. The account's history (D1 `chat_line`) holds the thread id, never
  the origin. The list is only on lianki.com (`/chat/sites`, linked from
  `/chat/history` while the flag is on), never on a host page.
- **Flag off**: nothing is bound at minting, the hub routes as M2, `/chat/sites`
  and `/api/chat/sites` are 404 and `?sub=` is refused.
- **Plain-http sites.** The frame on an `http://` page is not a secure
  context (a frame is secure only when every ancestor is), so
  `crypto.randomUUID` is missing there. Line ids are minted from
  `crypto.getRandomValues` (`packages/debug-chat/src/uuid.ts`); a send that
  still throws is logged and shown above the input (`sendFailed`), the draft
  kept.
- **`/api/chat/sites` 503 under `wrangler dev`, local only.** The route asks
  lianki-push over the `PUSH` binding (`https://lianki-push/internal/sub-threads`,
  answered on that hostname alone), the same pattern as `/internal/friends`
  (`lib/push-friends.ts`). Locally, with the main Worker and lianki-push in two
  `wrangler dev` sessions, the session started first keeps getting 503 "Worker
  … not found" from wrangler's dev registry on its binding to the later one,
  even after it reports `[connected]`, and restarting it breaks the other
  direction (wrangler 4.151, reproduced with two bare Workers). The route maps
  that to its own 503. On Cloudflare the binding is direct: `GET /api/chat/sites`
  answered 200 there, and the hub's answer does not depend on how many threads
  exist. The QA runs both Workers in one `wrangler dev` session behind a router
  instead, where both directions work (the same was seen for
  `/internal/box-closed`, `scripts/qa/qa-box-oauth.mjs`).
- **Deploys**: lianki-push (auth.ts, index.ts, debug.ts) and the main Worker;
  the flag goes on after the owner approves.

## What was built in M3 (share from the composer)

| piece                                            | where                                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| read, clean, escape (pure)                       | `packages/debug-chat/src/embed/share.ts`                                                                                            |
| port messages `need-share` / `share`             | `embed/frame-protocol.ts`, `embed/frame-guest.ts` (`share()`)                                                                       |
| the shell reads the page only when asked         | `src/partner-frame.ts` (`share` dep), `src/pill-chat.ts`                                                                            |
| the + menu's Share items, the composer, the hold | `AttachMenu.tsx` (`share`), `DebugChat.tsx` (`onShare`)                                                                             |
| the frame passes the attachment on his send      | `app/embed/partner/PartnerFrame.tsx`, `page.tsx`                                                                                    |
| strings (16 locales + context)                   | `shareSelection`, `sharePage`, `shareNoPage` in `learning-partner`                                                                  |
| tests                                            | `unit/pill-chat-share.test.ts`, `unit/partner-frame.test.ts`, `unit/support/debug-chat-mount.tsx`, `scripts/qa/qa-pill-chat.ts` §3b |

- In the frame the + menu's "Attach to message" holds **Share selection** and
  **Share page title and link** (trusted presses only). Each asks the shell
  over the port; the shell reads the page **then** (the selection, the
  title, the address) and answers into the port only. The frame checks the
  answer again.
- **Link**: http(s) only, origin + path; never the query, the fragment or
  userinfo (decision: conservative, as gate 5's label; he can paste a full
  address himself). `()<>[]"'` and spaces percent-encoded.
- **Title** goes into the draft markdown-escaped, so a hostile title renders
  literally; **selection** becomes the attachment chip (`ChatContext`, plain
  text), cut to config `chat.pillShareChars` (default 2000).
- **Never auto-sent.** A share fills the draft or the chip and holds the
  typing debounce (and the dictation burst) off until a line actually goes
  out: only Enter, the send button or a tap on the chip sends. Tested in
  happy-dom (typing after a share does not send after the 3 s pause) and in
  the source checks.

## What shipped (M1)

| piece                                                  | where                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| per-site decisions, the gate's rules (pure)            | `src/pill-chat-trust.ts`                                                                       |
| trust prompt, sites list (revoke), blocked note        | `src/pill-chat-ui.ts`                                                                          |
| the open path: entry → prompt → flag check → frame     | `src/pill-chat.ts`                                                                             |
| strings, 16 locales + context (one table, two readers) | `src/pill-chat-strings.ts`, intlayer `pill-chat` in `app/components/pill-chat.content.ts`      |
| `GET /api/ext/pill-chat` → `{ on }`                    | `app/api/ext/pill-chat/route.ts`, `lib/pill-chat-route.ts`                                     |
| the pill's Li button, the menu item                    | `src/lianki.user.ts` (`createUI`, `GM_registerMenuCommand`)                                    |
| tests                                                  | `unit/pill-chat.test.ts`; hostile page `scripts/qa/qa-pill-chat.ts` (qa:all suite `pill-chat`) |

How it behaves:

- **Who sees Li.** `GET /api/ext/pill-chat` answers `{ on: true }` only when
  the flag is on **and** the caller may have today's partner ticket (the
  owner, by session or a chat token — the same check as
  `/api/debug/partner-ticket`). The userscript asks it on lianki.com page
  loads (at most once a minute) and keeps the answer in GM storage
  (`lianki_pillchat_on`); other sites read only that, so **no request leaves
  for lianki.com on a site before he allows it**. Right before the frame
  opens it asks again: the flag is the kill switch.
  **Keeping the mirror fresh (2.24.38).** It was read only on a lianki.com
  page load, so turning the flag on from /dev/flags left the "off" read on
  that page's load in place, and the pill showed no Li anywhere until a
  lianki.com page loaded again a minute later. Now (`watchPillChatFlag`)
  lianki.com is asked again when a lianki.com tab comes back into view
  (still once a minute at most), at once when /dev/flags saves an
  `ext.pill-chat*` flag (the page's `lk:flag-changed` event,
  `lib/flag-events.ts`), and once more after the server's flag cache
  (30 s) ran out. The other site's pill picks it up when its tab is shown.
- **The entry.** A "Li" button at the end of the pill, in the top window
  only, hidden on a "never" site. A tap opens only on a trusted event
  (`isTrusted`): `el.click()` or a dispatched event from the page does
  nothing. In the page realm (guard.ts `isolatedWorld` false), the dedicated
  broker enables the limited mode described below. A caller without that
  broker retains the read-only note and fetches nothing.
- **The prompt** (open question 3: answered "keep Allow once"): Always on
  this site / Allow once / Never on this site, × and Escape and a click
  outside = dismiss = deny, nothing stored. Copy and the warning line
  (gate 7) as above. A closed shadow root on a plain div, styled through
  the CSSOM, oklch light/dark, 44 px targets, fits 360 px. Buttons act only
  on trusted events.
- **Decisions.** `lianki_lichat_sites` in GM storage, `{host: "allow" |
"never"}`, keyed by the top window's exact lowercase hostname (no www
  folding); junk in storage is dropped, never trusted. "Allow once" is
  memory for that page load.
- **Revoke.** The manager's menu "Li chat: sites…" (new `@grant
GM_registerMenuCommand`, registered only while the flag is on) opens the
  sites list: each host with its state and a Forget button. The
  /my/preferences copy and the account sync (`lk:` pref) are M4.
- **The frame.** `src/partner-frame.ts` as is: `/embed/partner`, strict
  origin handshake, `MessagePort`, ticket only into the port. New: a second
  `load` of the iframe (the page navigated it) tears it down. On a CSP
  `frame-src` block: the frame goes, a note with a link to lianki.com shows
  (no read-only chat in the page in this slice).

What the hostile-page QA showed, and what is left:

- `window.frames` does not list an iframe inside a (closed) shadow tree, so
  the page has no handle on the frame **until the frame says it is up**:
  `partner-frame-up` goes to the parent with `"*"`, and its `event.source`
  is the frame's WindowProxy. With it the page cannot read the frame
  (cross-origin), its own hello and port get nothing, and navigating the
  frame tears it down. A page that sends its hello **before** ours can
  still keep the frame from working (denial of service only, as before).
- Keys pressed on the **prompt** (Tab, Enter, Escape) are in the page's
  document, so the page sees them and can `preventDefault` them (blocking
  the keyboard path; the mouse still works). Typing in the chat itself is
  in the frame and never reaches the page.
- The in-frame one-time warning (gate 7, second half) is not built yet (M4).
  Share (gate 5/6) is M3, above.

## Goal

The userscript's pill (`data-lk="pill"` in `src/lianki.user.ts`) also opens
**Li**, the Learning Partner chat, on any page — the same chat as on
lianki.com, without leaving the article he is reading.

Today the owner already has Li on every site in debug mode
([dev-debug-widget.md](dev-debug-widget.md), "On every site" and "The frame:
private typing"): a lianki.com frame `/embed/partner` holding
`packages/debug-chat`, a ticket handed over a `MessagePort`. This feature
turns that into a user feature opened from the pill, and closes the gaps
that are acceptable for the owner alone but not for users.

## User flow

1. On any page, the pill gets a **Li** entry (long-press menu / a small
   bubble beside it; the pill's swipe-to-grade gestures are unchanged).
2. **First time on a site**: a trust prompt in the userscript's own closed
   shadow UI — "Allow Li chat on **example.com**?" with _Allow once_,
   _Always on this site_, _Never on this site_. Default (dismiss) = deny.
   The copy under it: "Li runs in its own window from lianki.com. This site
   cannot read what you type there. Li does not see this page unless you
   share something." (intlayer keys, 16 locales, with context lines.)
3. Allowed → the chat frame opens floating (drag, minimize, close; position
   per site, as `lianki_partner_pos`).
4. **Sharing the page is explicit**: a "Share selection" / "Share page title
   and link" button in the frame's composer; nothing is sent until he presses
   send.
5. Never → the pill shows no Li entry on that site; the choice is revocable
   in the userscript menu ("Li chat: sites…") and on lianki.com
   /my/preferences.

## Architecture

- **Frame**: reuse `/embed/partner` (`app/embed/partner/`), the one route any
  site may frame (`frame-ancestors *`), mounting `packages/debug-chat` with
  `embedded`. No owner boots there (`x-lianki-partner-frame`, already).
- **Shell**: `src/partner-frame.ts` (trusted userscript code, plain DOM, a
  closed shadow root holding grip + iframe), opened from the pill instead of
  the debug switch.
- **Handshake**: `embed/frame-protocol.ts` / `frame-guest.ts` as today:
  frame posts `partner-frame-up`, the shell checks `event.source` is its own
  iframe **and** `event.origin === "https://lianki.com"`, answers with a
  `MessagePort` to that exact origin; everything after goes over the port.
- **Tickets for users**: today's partner ticket names no account and the
  route gives it to the owner only. Users need a ticket that **names the
  account** (new audience, e.g. `lianki-li-chat`), minted by
  `POST /api/chat/li-ticket` for the session's own account, 60 s, single use
  (jti burned by lianki-push), chat-only scope: it opens that user's own Li
  thread ([partner-ai.md](partner-ai.md), caps and billing unchanged) and
  nothing else — no eval, pairing, grants or page lists.
- **Site trust store**: in the userscript's GM storage
  (`lianki_lichat_sites`: `{host: "allow" | "never"}`), mirrored to the
  account as an `lk:` pref ([prefs-sync.md](prefs-sync.md)) so a phone and
  a laptop agree. Keyed by the top window's exact hostname.
- **Blocked sites**: where the frame cannot load (CSP `frame-src`), fall back
  to the existing read-only note with a link to chat on lianki.com. No typing
  outside the frame, ever.

## Security gate (all must hold before shipping to users)

1. **Isolated cross-origin frame.** The chat renders only in the
   lianki.com iframe. The host page cannot read or write its DOM, storage or
   keystrokes (different origin). No shadow-DOM chat with an input on a
   foreign page.
2. **postMessage only, strict origins.** The shell accepts a message only
   from its own iframe's `contentWindow` with origin exactly
   `https://lianki.com`; it posts only with that target origin, never `"*"`.
   After the hello, only the `MessagePort` is used. The frame accepts the
   port only from `window.parent` at hello time and ignores every other
   message. Unit tests for spoofed source, spoofed origin and a page that
   posts first.
3. **Per-site trust, default deny.** No frame, no ticket fetch, no network
   call to lianki.com for chat until the user allows that site.
4. **Isolated mode keeps credentials outside the page.** The shell fetches the ticket with
   `GM_xmlhttpRequest` (outside the page's realm) and writes it into the
   port only. No `lk:token`, cookie or ticket in a URL, a DOM attribute, a
   page global or a `postMessage` to the page. Page-context mode instead uses
   a dedicated, reduced chat capability: see the chat-only mode below; it
   does not claim isolation from the host page.
5. **No page text auto-sent.** The frame never receives page content unless
   he presses Share; the label sent is host + path, never the query or hash
   (as today).
6. **Page-provided content is escaped.** Shared selections, titles and URLs
   are text: rendered as text in the chat, never as HTML or markdown links
   that run script; URLs limited to http(s).
7. **Warning copy** shown in the trust prompt (above) and once in the frame:
   Li can make mistakes; do not paste passwords or private data from this
   page.
8. **QA**: `scripts/qa/qa-partner-embed.ts` and
   `qa-partner-frame-route.ts` extended with a hostile page that listens on
   capture for keys, spoofs `message` events, overrides `postMessage`,
   `MessagePort` and `WebSocket`, and frames-busts; must pass in qa:all.

## Userscript version

The pill change ships in `lianki.user.js` with an `@version` bump (pre-commit
syncs `lianki.meta.js`) and a version note: "Pill: open Li chat on any
site (asks per site first)". New `@connect` hosts: none (lianki.com is
already granted).

## Milestones

| #   | slice                                                                                                                                                                                                                                                     | ETA  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| M1  | **Shipped.** Pill → Li entry for the owner only (flag dark), reusing the current owner ticket and `/embed/partner`; per-site trust prompt with default deny and the warning copy; sites list (revoke) in the manager menu; hostile-page QA; @version bump | 2.5H |
| M2  | **Built (2.24.35, dark for users).** Account-scoped `li-ticket` route + hub audience (chat-only, own thread), unit tests                                                                                                                                  | 3H   |
| M3  | **Built (2.24.35).** Share selection / page link from the composer, escaped; no auto-send test                                                                                                                                                            | 2H   |
| M4  | Security gate QA for the account ticket, trust list synced as a pref, revoke on /my/preferences                                                                                                                                                           | 3H   |
| M5  | Flag on for users after the gate passes and the owner approves                                                                                                                                                                                            | 0.5H |

ETAs include the local gate and ~10M pipeline.

## Open questions

1. ~~Pill entry: a long-press menu item, or a separate small Li bubble?~~
   Kept as M1 built it (2026-11-17, conservative): a "Li" button at the end
   of the pill; the swipe gestures are untouched. Revisit with the owner.
2. ~~Signed-out users?~~ No Li entry at all (2026-11-17, conservative): the
   flag route answers off without a session, so nothing shows and nothing is
   fetched on other sites.
3. ~~Should "Allow once" exist?~~ Kept in M1 (memory for the page load).
4. ~~The Chrome extension at the same time?~~ After the userscript
   (2026-11-17, conservative): `packages/ext` gets the entry only once the
   security gate has passed for the userscript.

## Installation and first-site trial

The signed-in `/chat/sites` list includes an installation panel. It checks
this page's live `data-lianki-userscript-version` marker against the shipped
`LIANKI_USERSCRIPT_VERSION` (generated from the userscript's `@version`).
An older version, or a legacy installed marker without a valid version,
offers the same installer link for an update. No current marker offers
installation; a stale `lk:status` localStorage entry alone is not evidence
that the script is still installed. MutationObserver and return-to-tab events
notice late injection without polling. After installing, reload the page.

The script publishes only this non-secret version on lianki.com, its www
redirect and preview.lianki.com, not on unrelated websites. It crosses
userscript isolated worlds through the DOM. This is a user-interface hint,
not an authentication or feature-permission check. No flags or account
permissions change. A current version offers example.com in a new tab and
explains the existing site-trust prompt and the pill's Li button.

The panel has sixteen locales with per-key context. Regression coverage:
`unit/userscript-install.test.ts`, `unit/pill-install-guide.test.tsx` and
`bun scripts/qa/qa-pill-install-guide.mjs` (silent fixtures, including an
isolated-world marker and 320px / 150% layouts; not production evidence).


## Page-context chat-only mode (随身Li)

A page-context manager keeps the existing LiCards initialization, scoring and
page buttons. Only the new chat uses a separate broker. After the same per-site
consent, that broker may check `/api/ext/pill-chat` and mint a ticket from
`POST /api/chat/page-ticket`; it never reads `lk:token` or forwards Authorization.
The mint requires the signed-in cookie, userscript header and a validated source
origin. Its distinct `lianki-page-chat` audience is valid for 60 seconds, one use,
and bound to the verified account and site thread. Existing ticket audiences
do not accept it.

The push Worker stamps chat-only mode from the verified capability, never from
a parent-selected UI parameter. Chat/history stay in the site's subthread and
do not become local-controller instructions. Embed message handling rejects
eval, code execution, token/settings/payment/private-data/pairing operations.
The AI receives only site-chat context, without learning summaries, language
preferences, roster or polish context. Advanced actions require opening the
first-party `/chat` page, where existing authorization and consent still apply.
The return link carries only an HTTP(S) source origin, never a page path, query
or fragment. Isolated-mode behavior is unchanged.

This deliberately does not repair the legacy page-context LiCards credential
boundary. That existing risk needs its own decision; disabling old features is
not part of this change. Chat history is exposed to the selected host site's
page environment by design; the one-use ticket is not a general API token.

Deployment requires both the main Worker (mint/UI) and `lianki-push` (new
audience/attachment), with push support available before minting is enabled.
No migration, new secret, account flag or manager permission is introduced.
Unit coverage includes capability replay/origin/site binding, advanced-frame
rejection, controller isolation and exclusion of learning data. The extended
`qa-pill-chat-sites.ts` uses synthetic accounts and silent page-world plus
isolated-world browser fixtures; it is not evidence of a real manager install.
Actual ScriptCat/Tampermonkey-to-site chat remains a separate post-deploy check.

## 随身Li: global consent and bundled CSP-independent chat (2.24.46, pending delivery)

No permanent chat-only/advanced-action banner is shown. The legacy page-realm startup also draws no status card; a real advanced capability denial can show a dismissible localized explanation and first-party link on demand.

The automatic chat path uses a statically bundled shadow-DOM panel and
`GM_xmlhttpRequest`, rather than relying on an iframe or the website's
`connect-src`. This works with a strict `frame-src 'none'; connect-src 'none'`
without changing the website's CSP. The older frame path remains available to
callers without the new manager transport. LiCards initialization, cards,
scoring and the existing three buttons are unchanged. The new dock reserves the
existing bottom-right card controls and stays below their dialogs in stacking order. The legacy Learning
Partner widget is suppressed when the new portable-chat subsystem owns chat,
so revoking permission or excluding a site cannot leave a second chat window.

- **Explicit global consent:** old per-site allow decisions never become a
  grant for every website. The new prompt discloses that websites may read
  conversation text, and that page content is not shared automatically.
  Consent is browser-local and bound to the verified account. A different
  signed-in account must consent again. Existing `never` sites remain excluded.
- **Automatic window:** after consent, each top-level website opens a docked
  chat panel without focusing its input. Collapse is remembered per hostname.
  Hidden/collapsed panels stop their outstanding reads. Exclusions cover a
  domain and its subdomains, never a lookalike suffix.
- **Management:** `/chat/sites` has browser-local enable/revoke/exclusion
  controls, even when the separate site-history flag is off. The settings
  event bridge exists only on the top-level trusted first-party settings
  route, including client navigation to that route. It cannot read arbitrary
  GM keys or change account settings. GM value-change listeners propagate
  revocation between tabs; managers without that API refresh on visibility.
- **Language:** the supported first-party Lianki `<html lang>` is mirrored to
  one non-secret GM preference and used on other sites. Foreign document
  language does not override it. Browser language is only a fallback before a
  first-party language has been observed. This fixes the French-browser /
  Chinese-Lianki mismatch; it does not change learning languages.
- **Transport:** `POST /api/chat/page-broker` accepts only `hello`, bounded
  `read`, and a text `send`. It requires the userscript header and the current
  login cookie, rejects any Authorization header, checks existing chat flags,
  and compares the expected account on each read/send. There is no general
  API-token fallback, caller-chosen account/thread, arbitrary URL or eval.
- **Private capability:** the main Worker signs a distinct
  `lianki-page-chat-http` Ed25519 capability for one exact action/body digest,
  account and origin-derived site thread. Its lifetime is 60 seconds; the
  destination Durable Object serializes one-use consumption. Capabilities
  travel only through the private PUSH service binding, never back to the
  userscript or page. Expiry-ordered keys allow bounded lazy replay cleanup.
- **History/replies:** the hub reuses the existing durable replay cursor and
  site-only AI path (`embed` and `chatOnly`); no learning summary or language
  data is added to the prompt. Public results copy only conversation text,
  logical timestamps, message IDs and replay coverage. Advanced metadata,
  credentials and internal headers are stripped. AI caps and billing remain
  unchanged. A sender retries an ambiguous failure with the same message ID;
  current-history duplicates do not post or request AI twice.
- **Bounded waiting:** reads wait for a durable write or a 20-second timeout,
  with at most four waiters per thread and 64 total. No short database polling
  interval or idle D1 write is added. The main Worker still authenticates and
  rate-limits each request, and one-use replay bookkeeping uses DO storage.
  User cancellation aborts the request; a message already accepted durably
  is not unsent. No microphone, playback or device access is part of this UI.

### The chat window is the main site's DebugChat (2.24.60)

Owner, 2026-11-26: 随身Li reuses the Li chat component, no second wheel, and
looks exactly like the chat window on lianki.com, everywhere (his sites
zhihu.com and github.com refuse frames). So there is one chat UI,
`packages/debug-chat`'s `DebugChat`, reached two ways (`src/portable-li.ts`
`show`):

1. **The lianki.com frame first** (`/embed/partner`, `src/pill-chat.ts`
   `portableFrame`): what he types stays in lianki.com's origin. Its
   chat-only ticket (60 s, single use, `lianki-page-chat`) comes only from
   the fixed cookie-only broker `POST /api/chat/page-ticket` (no
   Authorization, no `lk:token`, in every realm, ScriptCat raw included), is
   fetched only when the frame asks on its MessagePort and goes only into
   that port (contract: the backend lane's frame contract). It is bound to the
   consented account (`consentedFrameTicket`): the answer's `principal`
   must be the consented one; a valid different one closes the window,
   invalidates consent and asks again; a missing or malformed one gives no
   ticket ("can't connect", fail closed). An abort only drops the result
   locally; GM_xmlhttpRequest is not physically cancelled.
2. **Where the site's CSP refuses the frame** (`frame:blocked`): the same
   DebugChat **bundled into the userscript** (`src/portable-window.ts`,
   filled at build time by `scripts/portable-window-plugin.ts` from the
   partner build) in a closed shadow root at a fixed size (rem → px), fed
   only through the chat-only HTTP broker (`read` / `send`). No fetch, no
   eval, no remote code: the window's code is one function inside the
   script, run only when chat opens.

- **The frame counts only after the full handshake** (2.24.55, after the
  zhihu check drew the old prod embed as a 120 px box in French): it must say
  `portable-v1` in its "ready" (frame-protocol.ts `PORTABLE_CAP`; the embed
  deployed before this change does not) and take a ticket for the consented
  account within 6 s (`gatedFrameResult`). Otherwise it is torn down and the
  bundled window draws: `bundled frame:incompatible | frame:timeout |
  frame:no-ticket | frame:blocked`. So a dev build never shows an old embed.
  The frame has the bundled window's fixed size (`PORTABLE_FRAME_SIZE`,
  min(420 px, 100vw−16) × min(560 px, 100vh−24)), and its URL carries
  `?lang=` = his Lianki language (middleware reads it). The bundled window
  gets the chat's strings for that language from the same `learning-partner`
  dictionary, built in by the plugin (`portableChatStrings`).
- **Floating like lianki.com** (2.24.57; the opaque 2.24.56 panel was
  reverted at the owner's word: the 2.24.55 glass look is the one he wants).
  DebugChat floats over the page exactly as on the main site and drags across
  the whole viewport. It starts open at the bottom right: only the scoped
  drafts and a position he dragged it to (per site, `lianki_portable_ls:<origin>:lk:debug-chat-pos`)
  are kept in GM storage; fold, dock and compact are memory for the page, so
  no lianki.com position or minimized state carries over. Its grip (tap:
  minimize / restore, drag: move) and its menu's Minimize carry
  `data-lk-portable-toggle` (`grip` / `minimize`). For real-browser QA,
  which cannot reach into the closed root, <html> carries read-only geometry:
  `data-lk-portable-grip` and `data-lk-portable-rect` ("x,y,w,h", viewport CSS
  px, rounded), kept current on mount, drag end, resize, minimize and restore
  (`embed/portable-geometry.ts`). Nothing else: no text, no window API.
- **The frame is see-through** (2.24.60): /embed/partner's html and body
  were already transparent (`data-embed`), but its color-scheme was dark in
  dark mode while the shell's iframe said `normal`; on such a mismatch the
  browser paints an opaque canvas (the dark 420×560 box on 2.24.58). The
  embed document now says `color-scheme: normal` (globals.css
  `html[data-embed]`), matching the iframe; the dark tokens still apply, so
  the chat keeps the 2.24.55 glass. Takes effect when the app deploys.
  `scripts/qa/probe-frame-glass.ts --embed-normal` shows it on the live embed.
- **No other chat UI.** The hand-built plain panel is gone; `portable-li-panel.ts`
  keeps only the consent prompt's styles.
- **Drafts per account and site.** `draftScope` =
  `portable~<principal>~<origin>` in the bundled window (required by
  `mountPortable`), and `portable~<viewer>~<origin>` with `key` = scope in
  the frame (`lib/partner-frame-chat.ts`). A draft never follows another
  account or site.
- **Sends are cancellable.** Every send carries an AbortSignal; stopping the
  window aborts sends in flight and a late answer adds nothing.
- **No standing notice.** Only an advanced action (an `@/…` address, page
  context, files) shows 「去 lianki.com 为这个网站单独打开」 with a link to
  `/chat?from=<origin>`; nothing is sent for it. The frame no longer shows the
  chat-only line either.
- **Why this window.** `data-lk-portable` on `<html>` and one debug line say
  which window drew or why none did, as reason codes only: `frame`,
  `bundled frame:blocked`, `none frame:account-mismatch`,
  `none … bundle:absent`, `none … mount:error <Error: words>`.
- **Build.** `bun run build:userscript` is `scripts/build-userscript.ts`
  (the `userbuild` output plus the plugin). The dev servers use the same
  plugin. A build without it (unit tests, other tools) keeps
  `portable-window.ts` = null: frame only.
- **Cost.** `lianki.user.js` 364 KB → 2.6 MB (gzip 98 KB → 646 KB; the
  release build is formatted, so the bundled window is readable too). On a
  plain page with chat closed (muted headless Chromium, median of 11):
  compile 2.8 → 18.3 ms, run 5.1 → 4.8 ms, i.e. the window's code is parsed
  but not run (`scripts/qa/userscript-load-cost.ts`).

QA: `bun scripts/qa/qa-portable-li-sites.ts --shots <dir>` (the built
userscript in the page's world as ScriptCat raw runs it, on github.com,
www.zhihu.com and example.com, light and dark, synthetic broker, lianki.com
routed away); `qa-portable-li-window.ts` (strict-CSP fixture);
`qa-portable-li.ts` (consent, real route and hub, synthetic AI reply).

### Extension alternative — assessment only, not implemented

Chrome's [`declarativeNetRequest` API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
can set/remove/append response headers; it does not offer a general operation
that edits only `frame-src` inside an arbitrary CSP while preserving every
other directive. Appending another CSP would intersect restrictions rather
than relax the existing policy. Replacing/removing the whole header risks
losing nonces, multiple policies and unrelated protections.

The recommended current path is the GM broker plus bundled panel above. A
future extension side panel could avoid website CSP without rewriting it. A
site-scoped DNR alternative would need explicit host/modify-header permissions,
a complete policy-preservation design, separate security review and updated
Chrome Web Store permission/privacy disclosures and review. No extension,
CSP rule, permission or store submission is changed in this version.

### Acceptance and evidence boundaries

`bun scripts/qa/qa-portable-li.ts` runs muted Chromium with fake capture devices
and a strict-CSP local fixture. It covers consent-before-network, global
second-site auto-open, actual pointer send through the broker/hub to a
synthetic AI reply, separate histories, collapse persistence, exclusion and
remote GM revocation. Fixture injection simulates a userscript manager; it is
not evidence of production ScriptCat operation. After the reviewed security
change is approved and deployed (push before main), verify the served build,
then use the actual installed manager on `zhihu.com` and `github.com` to send
and receive a text reply. Keep the product node open until that real flow passes.
