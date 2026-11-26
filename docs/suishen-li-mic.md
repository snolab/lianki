# 随身Li mic: dictate from the lianki.com tab into the page you are on (spec, for review)

Status: **draft for review**. UI and this contract: agy lane; broker, hub and bridge: coco lane (branch `feat/portable-shared-mic`); review: codex lane.
Nothing is built. Flag **`portable.mic-route`**, default **off**, audience
**owner** (lib/flags.ts), switched on for the owner when it ships.

**Scope.** **v1:** dictated text is routed into the active page's 随身Li draft
only, with **no selection chip**. It needs the same per-site consent as
随身Li chat, the owner-only flag, no raw audio and no host-page mic. **v2**,
after #1125 deploys: the page's selection is attached as below
("Selection"); page.read is its own grant, asked separately, never implied
by the mic or the chat consent.

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

### 0. Keys: account + browser

Routing is **per browser**, never account-wide: a mic on one device never
types into a page on another. Both ends carry a **browser id** (`bid`): a
random id the userscript keeps in its GM storage (`lianki_browser_id`,
`[A-Za-z0-9_-]{16,64}`) and hands to the lianki.com tabs of the same browser
(the userscript runs there too, mirroring it into the page the way it already
mirrors the UI language). The hub keys every target and every source by
**account + bid**.

### 1. Broker ops (page broker, `POST /api/chat/page-broker`; coco)

Same rules as `read`/`send`: the userscript header, the login cookie, no
Authorization, the expected principal header compared on every call,
`x-lianki-host-origin` = this page's origin.

```ts
| { op: "route"; state: "on" | "beat" | "off"; bid: string; routeId: string; gen?: number }
| { op: "read"; afterSeq?: number; wait: boolean;
    dictation?: { routeId: string; gen: number; afterSeq?: number } }   // selector + receipt cursor
```

- `routeId`: this 随身Li window (random per window, `[A-Za-z0-9_-]{8,64}`);
  two windows on the same site have different ids.
- `on`: "this window takes this browser's dictation". The hub records
  `{account, bid, routeId, origin, gen}` as **the** target for that account +
  bid and answers a new generation `gen` (increasing). A newer `on` from any
  other window replaces it.
- `beat` (with `gen`): keeps it while the page is visible and the button on.
- `off` (with `gen`): clears it if it is still this `routeId` + `gen`.
- **Answer to every `route`:**
  `{ ok: true, kind: "route", state: "listening" | "no-source" | "off", gen }`.
  `off` = this window is not (or no longer) the target: a newer `on` took it,
  or it lapsed. The window shows **off** at once and stops beating.
  `listening` / `no-source` come from the source's own report (below).
- **Delivery with a receipt:** `read` carries the selector
  `{routeId, gen, afterSeq}`; the answer's range gets
  `dictation: { routeId, gen, items: { seq, text, at }[], throughSeq }`, only
  for that exact routeId + gen. Items stay queued until a later `read` names
  `afterSeq ≥ seq` (the ACK). Never dropped on read: a lost response re-sends
  them. Bounded: text ≤ 4000 chars, ≤ 50 queued per target, dropped only when
  the target ends (generation change) or after 10 minutes unacked. Not chat
  history: never a thread line.
- Refused like the other ops (`account-changed`, `signed-out`, `off` when the
  flag is off for this account, or no 随身Li consent for this site).

### 2. Hub messages (DebugHub; coco)

- **Source presence (explicit):** a lianki.com tab reports its mic with
  `{ type: "dictation-source", bid, state: "on" | "off" }` when its chat mic
  turns on or off, and `off` when it closes or hides its socket. `listening`
  in the `route` answer is derived only from these reports (any tab of the
  same account + bid with `on`), never inferred.
- **Target fan-out:** to the lianki.com tabs of the same account + bid, on
  every change: `{ type: "dictation-target", target: { origin, routeId, gen } | null }`.
- **A final:** `{ type: "chat-dictation", routeId, gen, text, at }` from a
  lianki.com tab. The hub checks it is still the target's routeId + gen and
  the same account + bid, then queues it for that target. Otherwise it is
  ignored and the tab gets `dictation-target: null` (its own composer again).
- **Stop:** `{ type: "dictation-stop", bid }` from a lianki.com tab (its "→
  site" label) clears the target for that bid; the window's next `route`
  answer is `off`.

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
- Tap: `route on` (and `beat` every 20 s while visible). Tap again, Escape,
  closing the window, hidden, `pagehide`: `route off` at once. A `route`
  answer of `off` turns the button off.
- `read` carries the dictation selector `{routeId, gen, afterSeq}`; each
  delivered item is appended once (by `seq`) and ACKed by the next `read`.
- Each routed final is appended to the composer draft (a space between), never
  sent by itself. The draft scope stays `portable~<account>~<origin>`.
- **Selection (v2, after #1125 deploys; not in v1)**: when a final arrives and this page has a selection, it is
  attached the way #1125's `page.read` selection attachment does it (the chat's
  `context` chip: text, cleaned and capped by `chat.pillShareChars`, http(s)
  link only), from **this** page only, read at that moment. No selection → no
  chip. This reuses #1125's path; no second selection reader.

## The active tab rule

- **Who is the target:** in this browser, the 随身Li window whose mic button
  was turned on last (`route on`). Turning it on in another window or tab
  moves the target there; the old one learns it on its next `route` answer
  (`off`) and shows **off**.
- **Hidden = off at once:** on `visibilitychange` to hidden (or `pagehide`)
  the window sends `route off` immediately and the hub bumps the generation,
  so no late text lands on a page he has left. Coming back does not take the
  target back by itself: he taps the button again (a new `on`, a new `gen`).
- **Focus:** never moves the target by itself.
- **Explicit revoke:** the button, Escape in the window, closing it, the
  lianki.com tab's "→ site" label (`dictation-stop`), consent withdrawn, site
  excluded, the flag off.
- **Lapse (fallback only):** a dropped connection with no `off` (crash,
  network) — no beat for 60 s → the hub clears the target and bumps `gen`.
- Whenever the target ends, the lianki.com tabs get `dictation-target: null`
  and their finals go back to their own composer.

## Account binding

- Both ends are the same account **and the same browser**: the broker checks
  the expected principal on every `route` and `read` (as for the frame
  ticket, the session-verified principal), and the hub keys targets and
  sources by account + bid; only lianki.com sockets of that account and bid
  receive `dictation-target` or may send `dictation-source`,
  `chat-dictation` or `dictation-stop`.
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

- Broker: `route` parse/refuse, principal mismatch, one target per account +
  bid, newest wins and the old window gets `off`, hidden → off and gen bump,
  60 s lapse fallback, `dictation` selector by routeId + gen, receipt cursor
  (an unacked item is re-sent after a lost response), bounds in
  `publicPageChatResult`.
- Hub: explicit `dictation-source` presence, target fan-out per account + bid,
  stale routeId/gen ignored, other account or other bid refused,
  `dictation-stop`.
- lianki.com tab: final → `chat-dictation` only while a target is set; partials
  stay local; stop label clears.
- 随身Li: button states, append without sending, `route off` on close /
  pagehide / Escape, only on a site with 随身Li consent; v2 adds the selection
  chip only from this page.
- Real browser: two tabs (lianki.com fixture with a fake STT final, example.com
  with 随身Li), the text lands in the composer (v2: with the selection chip).
