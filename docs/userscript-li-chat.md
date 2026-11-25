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

| piece                                            | where                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| audience `lianki-li-chat`, `sub` = D1 user id    | `lib/stt-ticket.ts` (`LI_CHAT_TICKET_AUD`, `isTicketSub`)                                 |
| who may open Li, with which ticket               | `lib/pill-chat-route.ts` `pillChatAccess` → `GET /api/ext/pill-chat` `{ on, ticket }`     |
| `POST /api/chat/li-ticket`                       | `lib/li-ticket-route.ts`, `app/api/chat/li-ticket/route.ts`                               |
| hub: verify, route to the account's own thread   | `workers/push/src/auth.ts` `liChatTicket`, `index.ts`, `debug.ts` `connectPage` (`embed`) |
| userscript: fetch the ticket lianki.com names    | `src/pill-chat.ts` (`TICKET_PATHS`)                                                       |
| tests                                            | `unit/li-ticket.test.ts`, `unit/pill-chat.test.ts`                                        |

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

## What was built in M3 (share from the composer)

| piece                                              | where                                                         |
| -------------------------------------------------- | ------------------------------------------------------------- |
| read, clean, escape (pure)                         | `packages/debug-chat/src/embed/share.ts`                      |
| port messages `need-share` / `share`               | `embed/frame-protocol.ts`, `embed/frame-guest.ts` (`share()`) |
| the shell reads the page only when asked           | `src/partner-frame.ts` (`share` dep), `src/pill-chat.ts`      |
| the + menu's Share items, the composer, the hold   | `AttachMenu.tsx` (`share`), `DebugChat.tsx` (`onShare`)       |
| the frame passes the attachment on his send        | `app/embed/partner/PartnerFrame.tsx`, `page.tsx`              |
| strings (16 locales + context)                     | `shareSelection`, `sharePage`, `shareNoPage` in `learning-partner` |
| tests                                              | `unit/pill-chat-share.test.ts`, `unit/partner-frame.test.ts`, `unit/support/debug-chat-mount.tsx`, `scripts/qa/qa-pill-chat.ts` §3b |

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
  nothing. In the page realm (guard.ts `isolatedWorld` false) the tap only
  shows the existing page-realm note; nothing is fetched.
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
4. **The token never reaches the page.** The shell fetches the ticket with
   `GM_xmlhttpRequest` (outside the page's realm) and writes it into the
   port only. No `lk:token`, cookie or ticket in a URL, a DOM attribute, a
   page global or a `postMessage` to the page. The manager must not run the
   script in the page realm (`guard.ts`'s `pageRealm` blocker applies).
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
| M2  | **Built (2.24.35, dark for users).** Account-scoped `li-ticket` route + hub audience (chat-only, own thread), unit tests                                                                                                                                                                       | 3H   |
| M3  | **Built (2.24.35).** Share selection / page link from the composer, escaped; no auto-send test                                                                                                                                                                                 | 2H   |
| M4  | Security gate QA for the account ticket, trust list synced as a pref, revoke on /my/preferences                                                                                                                                                              | 3H   |
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
