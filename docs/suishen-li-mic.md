# 随身Li mic: dictate from the lianki.com tab into the page you are on (spec, for review)

Status: **draft for review**. UI and this contract: agy lane; broker, hub and bridge: coco lane (branch `feat/portable-shared-mic`); review: codex lane.
Nothing is built. Flag **`portable.mic-route`**, default **off**, audience
**owner** (lib/flags.ts), switched on for the owner when it ships.

**Scope.** **v1:** dictated text is routed into the active page's 随身Li draft
only, with **no selection chip** (#1125's page.read is not deployed yet). It
needs the same per-site consent as 随身Li chat, the owner-only flag, no raw
audio and no host-page mic. **v2**, after #1125 deploys: the page's selection
is attached as below ("Selection").

The owner, 2026-11-27 04:06 JST: 随身Li shows a mic button on every site. It
does not open a mic on that site: it borrows the mic of the lianki.com tab next
to it (on a PC, usually), so he can speak there and the words land in the site
he is working on, with that page's context (the selected text).

## The boundary: audio never leaves the lianki.com tab

- The mic, its permission, the STT (local Whisper / cloud / browser, as today:
  [voice-mode.md](voice-mode.md), [li-sound-hub.md](li-sound-hub.md)) and any
  clip storage stay in the lianki.com tab, unchanged. No `getUserMedia` on the
  host page, no new permission there, no audio over the broker or the hub.
- Only **final text** crosses: one line per final (the same unit the chat mic
  already puts into its own composer). Partials stay in the lianki.com tab.
- Nothing is sent to Li by routing. The text lands in 随身Li's composer as a
  draft; he sends it (Enter / send), as with the main site's dictation.

## The pieces

```
lianki.com tab (DebugChat + mic)        hub (DebugHub DO)            site tab (随身Li)
  final text ──── chat-dictation ──────▶ routes to the target ──────▶ broker read → composer
                ◀── dictation-target ─── (target set/cleared by ◀──── broker op: route
                    (who listens now)      the 随身Li page)            set / beat / clear
```

### 1. Broker op (page broker, `POST /api/chat/page-broker`; coco)

New op in `lib/page-chat-http-wire.ts`, same rules as `read`/`send`: the
userscript header, the login cookie, no Authorization, the expected principal
header compared on every call, `x-lianki-host-origin` = this page's origin.

```ts
| { op: "route"; state: "on" | "beat" | "off"; id: string }
```

- `id`: this page's route id (random per page load, `[A-Za-z0-9_-]{8,64}`).
- `on`: "send this account's dictation to me". The hub records
  `{account, id, origin, at}` as **the** target (one per account; a newer `on`
  replaces an older one: the tab he used last wins).
- `beat`: keeps it (every 20 s while the page is visible and the button is
  on); no beat for 60 s = the target lapses.
- `off`: clears it if it is still this `id`.
- Answer: `{ ok: true, kind: "route", state: "listening" | "no-source" }`:
  `listening` when at least one lianki.com tab of the same account has its
  chat mic on; `no-source` otherwise (the button offers "open lianki.com").
- Refused like the other ops (`account-changed`, `signed-out`, `off` when the
  flag is off for this account).

Delivery to the page: the existing long-poll `read` gets a new range field,
`dictation: { id, text, at, seq }[]` (finals for this route id since the
last read), copied by `publicPageChatResult` with the same bounds as messages
(text ≤ 4000 chars, ≤ 50 per read). Not chat history: never stored as a
thread line, dropped once read or after 60 s.

### 2. Hub messages (DebugHub; coco)

- To lianki.com tabs of the account, on every target change:
  `{ type: "dictation-target", target: { origin, id } | null }`.
- From a lianki.com tab, a final while a target is set:
  `{ type: "chat-dictation", id, text, at }`. The hub checks the target is
  still `id` and the same account, then queues it for that page's `read`.
  A stale `id` → ignored, and the tab is told `dictation-target: null`.

### 3. The lianki.com tab (DebugChat mic path; agy)

- Flag off or `target: null`: nothing changes.
- `target` set: a mic **final** goes to the hub as `chat-dictation` instead of
  into this tab's own composer; partials still show here, greyed, with
  "→ example.org" so he sees where it goes. One tap on that label (or the
  page's own "stop") clears the route for this tab: back to its own composer.
- The read-aloud, wake word, merge and polish logic stay as they are; a routed
  line is not merged into this tab's composer text.

### 4. 随身Li (portable window; agy)

- A mic button in the composer, same look as the main site's
  (`MicButton.tsx`), states shown as in [design-principles.md](design-principles.md)
  "switches show all states":
  - **listening**: lianki.com's mic is live and routing here (seal red);
  - **no lianki.com tab**: a link "open lianki.com" (opens `/chat`, where he
    turns the mic on); the button stays armed and turns listening when a tab
    with a live mic appears (the next `route beat` answer);
  - **off**.
- Tap: `route on` (and `beat` while visible). Tap again, Escape, closing the
  window, `pagehide`: `route off`.
- Each routed final is appended to the composer draft (a space between), never
  sent by itself. The draft scope stays `portable~<account>~<origin>`.
- **Selection (v2, after #1125 deploys; not in v1)**: when a final arrives and this page has a selection, it is
  attached the way #1125's `page.read` selection attachment does it (the chat's
  `context` chip: text, cleaned and capped by `chat.pillShareChars`, http(s)
  link only), from **this** page only, read at that moment. No selection → no
  chip. This reuses #1125's path; no second selection reader.

## The active tab rule

- **Who is the target:** the 随身Li page whose mic button was turned on last
  (`route on`), per account. Turning it on in another site's tab moves the
  target there; the previous page sees `state` change on its next beat and
  shows **off**.
- **Visibility:** a hidden page stops beating; after 60 s it lapses. A page
  that becomes visible again with the button on sends `route on` again (it
  takes the target back: he is working there).
- **Focus:** not used to move the target by itself (a click into another
  window must not steal dictation); only the button and visibility do.
- **Explicit revoke:** the button, Escape in the window, closing it, the
  lianki.com tab's "stop" label, consent withdrawn, site excluded.
- **Disconnect / timeout:** no beat for 60 s, the broker refusing
  (account-changed, signed-out, flag off), or the 随身Li page gone → the hub
  clears the target and tells the lianki.com tabs `target: null`: their
  finals go back to their own composer.

## Account binding

- Both ends are the same account: the broker checks the expected principal on
  every `route` and `read` (as for the frame ticket, the session-verified
  principal); the hub keys targets by account and only lianki.com sockets of
  that account receive `dictation-target` or may send `chat-dictation`.
- If the lianki.com cookie switches account, the 随身Li window closes and asks
  for consent again (the existing `account-changed` path); the old target
  lapses.

## Privacy

- No audio stored beyond what lianki.com already does (its clips setting).
- Routed text is transient: not a chat line, not in history, not logged with
  its text (counts only).
- The host page never gets the text through the DOM before he sends it: the
  composer is in the closed shadow root (bundled window) or the lianki.com
  frame; as with typed text, a page-realm script can read what is drawn there.

## Tests (planned)

- Broker: `route` parse/refuse, principal mismatch, one target per account,
  newest wins, 60 s lapse, `dictation` bounds in `publicPageChatResult`.
- Hub: target change fan-out, stale id ignored, other account refused.
- lianki.com tab: final → `chat-dictation` only while a target is set; partials
  stay local; stop label clears.
- 随身Li: button states, append without sending, `route off` on close /
  pagehide / Escape, only on a site with 随身Li consent; v2 adds the selection
  chip only from this page.
- Real browser: two tabs (lianki.com fixture with a fake STT final, example.com
  with 随身Li), the text lands in the composer (v2: with the selection chip).
