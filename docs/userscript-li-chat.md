# Li chat from the userscript pill (design stub)

State-tree node `/ext/li-chat`. Status: **M1 shipped (userscript 2.24.30)**
— the trust gate and the pill's Li entry, owner only; M2–M5 open. Flag
**`ext.pill-chat`**, default off, on for the owner when it ships. The
**security gate** below must pass in full before the flag is turned on for
anyone but the owner.

## What shipped (M1)

| piece | where |
| ----- | ----- |
| per-site decisions, the gate's rules (pure) | `src/pill-chat-trust.ts` |
| trust prompt, sites list (revoke), blocked note | `src/pill-chat-ui.ts` |
| the open path: entry → prompt → flag check → frame | `src/pill-chat.ts` |
| strings, 16 locales + context (one table, two readers) | `src/pill-chat-strings.ts`, intlayer `pill-chat` in `app/components/pill-chat.content.ts` |
| `GET /api/ext/pill-chat` → `{ on }` | `app/api/ext/pill-chat/route.ts`, `lib/pill-chat-route.ts` |
| the pill's Li button, the menu item | `src/lianki.user.ts` (`createUI`, `GM_registerMenuCommand`) |
| tests | `unit/pill-chat.test.ts`; hostile page `scripts/qa/qa-pill-chat.ts` (qa:all suite `pill-chat`) |

How it behaves:

- **Who sees Li.** `GET /api/ext/pill-chat` answers `{ on: true }` only when
  the flag is on **and** the caller may have today's partner ticket (the
  owner, by session or a chat token — the same check as
  `/api/debug/partner-ticket`). The userscript asks it on lianki.com page
  loads (at most once a minute) and keeps the answer in GM storage
  (`lianki_pillchat_on`); other sites read only that, so **no request leaves
  for lianki.com on a site before he allows it**. Right before the frame
  opens it asks again: the flag is the kill switch.
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
  /preferences copy and the account sync (`lk:` pref) are M4.
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
- The in-frame one-time warning (gate 7, second half) and Share (gate 5/6)
  are not built: the frame is still the owner's `/embed/partner`.

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
   /preferences.

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

| #   | slice                                                                                                                                                                                               | ETA  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| M1  | **Shipped.** Pill → Li entry for the owner only (flag dark), reusing the current owner ticket and `/embed/partner`; per-site trust prompt with default deny and the warning copy; sites list (revoke) in the manager menu; hostile-page QA; @version bump | 2.5H |
| M2  | Account-scoped `li-ticket` route + hub audience (chat-only, own thread), unit tests                                                                                                                 | 3H   |
| M3  | Share selection / page link from the composer, escaped; no auto-send test                                                                                                                           | 2H   |
| M4  | Security gate QA for the account ticket, trust list synced as a pref, revoke on /preferences                                                                                                                 | 3H   |
| M5  | Flag on for users after the gate passes and the owner approves                                                                                                                                      | 0.5H |

ETAs include the local gate and ~10M pipeline.

## Open questions

1. Pill entry: a long-press menu item, or a separate small Li bubble beside
   the pill?
2. Signed-out users on a site: show a "sign in on lianki.com" note, or no Li
   entry at all?
3. ~~Should "Allow once" exist?~~ Kept in M1 (memory for the page load).
4. Does the Chrome extension (`packages/ext`) get the same entry at the same
   time, or after the userscript?
