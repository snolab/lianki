# 随身Li mic: dictate from the lianki.com tab into the page you are on (spec, for review)

Tree: /chat/suishen-li-mic

Status: **draft for review**. UI and this contract: agy lane; broker, hub and bridge: coco lane (branch `feat/portable-shared-mic`); review: codex lane.
Nothing is built. Flag **`portable.mic-route`**, default **off**, audience
**owner** (lib/flags.ts), switched on for the owner when it ships.

**Scope.** **v1:** dictated text is routed into the active page's 随身Li draft
only, with **no selection chip**. It **requires the per-origin
`page.dictation` grant** (below; the 随身Li chat consent alone is not enough),
the owner-only flag, no raw audio and no host-page mic. **v2**,
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

### Grant: `page.dictation`, per site, at lianki.com

Dictation into a site is an advanced capability, switched on **per exact
origin** by him at lianki.com/chat/sites (first-party session + CSRF/Origin
checks; the site-capability design, scope `page.dictation`), separate from the
chat consent and from `page.read`. It is stored server-side as account +
canonical origin + scope + revision and revocable there at once. The GM-side
origin is not proof of the host: `route` and `read` (with a dictation selector)
check the grant at the authority on every call; no grant, or an older
revision → refused (`no-grant`), the button shows "open lianki.com to allow
dictation on this site". Revoking ends the target and clears its pending text.

The grant page says plainly: in page mode (ScriptCat raw) the 随身Li draft and
the routed transcript are drawn in this site's page, so **the site can read
them** before he sends anything, as it can read typed text there.

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
// Page broker ops (POST /api/chat/page-broker), complete:
| { op: "hello" }                                                     // unchanged
| { op: "send"; id: string; text: string }                            // unchanged
| { op: "route"; state: "on"; bid: string; routeId: string }          // take a new lease
| { op: "route"; state: "beat" | "off"; bid: string; routeId: string; gen: number }
| { op: "read"; afterSeq?: number; wait: boolean;
    dictation?: { bid: string; routeId: string; gen: number; afterSeq?: number } }

// Answers
| { ok: true; kind: "route"; state: "listening" | "no-source" | "off"; gen: number }
| { ok: true; kind: "history"; range: ChatReplayRange & {
      dictation?: { routeId: string; gen: number; throughSeq: number;
                    items: { seq: number; finalId: string; text: string; at: number }[] } } }
// One error shape for every op (route, read, send, hello):
| { ok: false; error: "no-grant" | "invalid" | "stale" | "off" | "account-changed"
                    | "signed-out" | "rate-limited" | "busy" | "unavailable"; gen?: number }
```

Field rules: `bid` `[A-Za-z0-9_-]{16,64}`, `routeId` `[A-Za-z0-9_-]{8,64}`,
`gen` / `seq` / `afterSeq` safe non-negative integers, `finalId`
`[A-Za-z0-9_-]{8,64}`, unknown keys refused (as `parsePageChatHttpInput`
does today). `stale` = the `gen` (or routeId) is no longer the target's;
`gen` in an error, when present, is the current one for this window (or
absent when it holds none). **ACK upper bound:** `dictation.afterSeq` must be ≤ the highest
`seq` already delivered to that routeId + gen; anything higher is refused
`invalid` and changes nothing, so an arbitrary cursor cannot erase items that
were never delivered.

- `routeId`: this 随身Li window (random per window, `[A-Za-z0-9_-]{8,64}`);
  two windows on the same site have different ids.
- `on`: "this window takes this browser's dictation". The hub records
  `{account, bid, routeId, origin, gen}` as **the** target for that account +
  bid and answers a new generation `gen` (increasing). A newer `on` from any
  other window replaces it.
- `beat` (with `gen`): keeps that exact lease while the page is visible and
  the button on. A beat never acquires, re-acquires or preempts a target: a
  beat for a lease that is gone is answered `off`, and nothing else changes.
- `off` (with `gen`): clears it if it is still this `routeId` + `gen`.
- **Each activation is its own lease:** only `on` (one per button tap) takes a
  target, with a new `gen`. Every answer and every `dictation` range carries
  the `gen` it is about; the window drops anything for another `gen`, so a
  late answer to an old on/beat/off/read can never revive a lease.
- **Answer to every `route`:**
  `{ ok: true, kind: "route", state: "listening" | "no-source" | "off", gen }`.
  `off` = this window is not (or no longer) the target: a newer `on` took it,
  or it lapsed. The window shows **off** at once and stops beating.
  `listening` / `no-source` come from the source's own report (below).
- **Delivery with a receipt:** `read` carries the selector
  `{bid, routeId, gen, afterSeq}`; the answer's range gets
  `dictation: { routeId, gen, items: { seq, finalId, text, at }[], throughSeq }`, only
  for that exact routeId + gen. Items stay queued until a later `read` names
  `afterSeq ≥ seq` (the ACK). Never dropped on read: a lost response re-sends
  them. Bounded: text ≤ 4000 chars, ≤ 50 queued per target, dropped only when
  the target ends (generation change) or after 10 minutes unacked. Not chat
  history: never a thread line.
- Refused like the other ops (`account-changed`, `signed-out`, `off` when the
  flag is off for this account, or no 随身Li consent for this site).

### 2. Hub messages (DebugHub; coco)

```ts
// lianki.com tab → hub (its existing authenticated socket)
| { type: "dictation-source"; bid: string; state: "on" | "off" }
| { type: "chat-dictation"; bid: string; routeId: string; gen: number; sgen: number;
    finalId: string; text: string; at: number }
| { type: "dictation-stop"; bid: string }
// hub → lianki.com tab
| { type: "dictation-source-ok"; bid: string; sgen: number }          // answer to source "on": the lease
| { type: "dictation-target"; bid: string; target: { origin: string; routeId: string; gen: number } | null }
| { type: "dictation-acked"; finalIds: string[] }
| { type: "dictation-returned"; finalIds: string[]; why: "rejected" | "target-changed" | "revoked" | "expired" | "gone" | "full" }
| { type: "dictation-unconfirmed"; finalIds: string[]; why: "target-changed" | "revoked" | "expired" | "gone" }
```

`sgen` is handed out only in `dictation-source-ok`, the answer to that tab's
`dictation-source on`; it is assigned by the hub and bound to that
authenticated first-party socket, never accepted as caller-chosen authority.
The source waits for it before sending any final; a `chat-dictation` with any
other `sgen` is returned (`dictation-returned`, why `rejected`). The browser id
is an isolation selector, not account authorization.

- **The source may capture in the background.** The lianki.com tab keeps
  listening and routing while it is hidden (that is the point: he talks there
  while he works in the site's tab). Only a hidden **target** page goes off at
  once.
- **Source presence (explicit, one lease):** a lianki.com tab reports its mic
  with `{ type: "dictation-source", bid, state: "on" | "off" }` when its chat
  mic turns on or off, and `off` when it closes its socket. `on`
  takes the **single source lease** for that account + bid (a source `sgen`;
  the newest tab wins, an older one gets `dictation-target: null`).
  `listening` in the `route` answer comes only from a live source lease,
  never inferred.
- **Target fan-out:** to the lianki.com tabs of the same account + bid, on
  every change: `{ type: "dictation-target", target: { origin, routeId, gen } | null }`.
- **A final:** `{ type: "chat-dictation", routeId, gen, sgen, finalId, text, at }`
  from the lianki.com tab holding the source lease. The hub checks it is still
  the target's routeId + gen, the current source `sgen`, the same account +
  bid, and a grant; it dedups by (account, bid, sgen, gen, finalId) and queues
  it. What happens to a final after that (or when it is refused, or the
  target ends) is defined only in "Delivery and ACK".
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
- Returned and unconfirmed finals: see "Delivery and ACK".

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
- `read` carries the dictation selector `{bid, routeId, gen, afterSeq}`; each
  delivered item is appended once (by `finalId`) and ACKed by the next `read`.
- Each routed final is appended to the composer draft (a space between), never
  sent by itself. The draft scope stays `portable~<account>~<origin>`. A
  stale, refused or timed-out delivery never clears or rewrites what is
  already in the draft.
- **Selection (v2, after #1125 deploys; not in v1; plain dictation never
  needs it)**, in this order, through #1125's page.read flow: (1) the
  `page.read` grant status for this exact origin is OK; (2) only then read
  this page's selection (cleaned, capped by `chat.pillShareChars`, http(s)
  link only); (3) `consume` it (revision, text digest, account binding) and it
  is OK; (4) only then attach it as the chat's context chip. A revoke, an
  account switch or a late arrival is rejected before consume and before
  attaching; nothing is attached on any failure.

## Delivery and ACK (the single authority for what happens to a final)

Promise, exactly: a final is **kept and not automatically duplicated while its
source session is alive or restorable**; a manual restore is labelled
未确认送达. Closing the source tab, clearing browser storage or a browser
failure can lose words. There is no extra storage and no audio kept to
compensate.

- **The source holds the copy.** The lianki.com tab that heard a final keeps
  it in a local outbox `{finalId, routeId, gen, sgen, text, at}` from the
  moment it sends `chat-dictation` until the hub settles it. Each entry also
  records the **verified principal** (the session-verified account id the hub
  stamped on `dictation-source-ok`). The outbox is isolated per **principal +
  bid + source tab** (a random tab id, `stid`): it lives in that tab's
  `sessionStorage` under `lk:dictation-outbox:<principal>:<bid>:<stid>`.
- **Recheck before any restore or refill:** before reading, restoring or
  appending a stored final, the tab checks that the currently signed-in,
  verified principal equals the entry's. Otherwise nothing is restored, and the
  entries stay inaccessible until that account returns (or that account
  discards them). A failed check never falls back to an unscoped draft.
  Counterexample that must fail: account A dictates, A's line is
  `dictation-returned`, the tab signs in as B before restoring → B's draft
  gets nothing; signing back in as A offers A's line again.
- **Persistence, honestly:** `sessionStorage` survives a reload of that tab
  but **not closing it**. A closed source tab loses its unsettled local copy;
  anything the hub had not delivered is then gone too (the hub drops it on
  the source's disconnect, below). This is the chosen trade-off (no
  cross-tab store of dictated text); the "N lines may not have arrived" note
  says so.
- **Hub states per final:** `queued` (accepted for the target, never yet in a
  `read` answer) → `delivered` (sent in at least one `read` answer) → `acked`
  (a later `read` from that bid + routeId + gen names `afterSeq ≥ seq`).
  **Queued is not delivered:** only a `read` answer moves an item on.
- **Source disconnect:** when the source's socket closes, the hub drops its
  queued (never delivered) items for that `sgen`; delivered ones still reach
  the page as usual.
- **Re-delivery is idempotent by `finalId`:** the hub re-sends every
  delivered-but-unacked item on each `read` of the same bid + routeId + gen
  (a lost response loses nothing); the page appends each `finalId` at most
  once for its lease and ACKs by `seq`. A source resending after a reconnect
  reuses the same `finalId`; the hub dedups it.
- **How a final is settled, exactly once:**
  - `acked` → `dictation-acked`: the source drops its copy.
  - Never delivered (still `queued`) when the target ends, is revoked,
    expires (10 min), the queue is full (50) or the final is rejected →
    `dictation-returned`: the page cannot have it, so the source puts its own
    copy into **its own** draft, marked "delivery not confirmed" (未确认送达),
    in order. (Hub-side rejections use these messages; broker calls use the
    one error shape above.)
  - Delivered but not acked when the target ends (the ACK may be lost: the
    page may already have appended it) → `dictation-unconfirmed`: the source
    does **not** put it into its draft by itself; it keeps the copy and shows
    "N lines may not have arrived — restore" with one tap that restores them
    into its draft (until that tab closes). So a lost ACK never both appends to the target and
    returns to the source, and nothing is dropped while the source tab is
    open (a closed source tab loses its unsettled lines; see "Persistence").
  - The source returns or restores only on these explicit hub messages, never
    on a timeout of its own.
- **Privacy revoke:** revoking `page.dictation` makes the hub delete that
  target's broker queue at once (`revoked`); the source's local copy may be
  kept (returned or restorable into its own draft) but is **never re-sent to
  that site**.
- **Page side:** a stale, refused or timed-out delivery never clears or
  rewrites the page's existing draft; items for another `gen` are ignored.

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
- A closed shadow root is not a privacy boundary: in page mode the site can
  read the draft and the routed transcript (the grant page says so).

## Tests (planned)

- Outbox isolation: another principal or another tab never restores the
  entries; a reload keeps them, closing the tab drops them. Cross-account
  counterexample: A's returned line, then signing in as B → B's draft stays
  untouched; back as A → the line is offered again.
- Every op's refusal has the one error shape `{ok:false, error, gen?}`.
- Synthetic delivery scenarios (no audio): (a) accepted → the target ends
  (change / revoke / disconnect) → returned to the source; (b) queue full →
  `full` returned; (c) 10-minute expiry → returned; (d) a lost ACK: the page
  appends once, the source gets `dictation-unconfirmed` (no automatic
  return), so no double append and no double return; (e) `afterSeq` above
  the delivered high-water mark → `invalid`, nothing erased; (f) privacy
  revoke deletes the queue and nothing is re-sent to that site.

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
