# Lianki Sync Architecture

## Overview

Lianki uses three storage layers that must stay consistent:

| Layer | Technology | Scope | Persistence |
|---|---|---|---|
| **Script storage** | `GM_setValue` (Tampermonkey) | Per-device, all sites | Until manually cleared |
| **Site storage** | IndexedDB `lianki-keyval` | lianki.com only | Until browser clears |
| **Cloud** | MongoDB (per-user collection) | All devices | Permanent |

Conflict resolution uses **Hybrid Logical Clocks (HLC)** — a CRDT strategy. The card with the higher HLC wins.

---

## Storage Layers in Detail

### 1. Script Storage — `GM_setValue`

The primary client-side store. Holds all card data, the sync queue, and device config.

| Key | Format | Purpose |
|---|---|---|
| `lk:deviceId` | UUID string | Per-device identifier, generated once |
| `lk:config` | JSON | `{ lastSyncHLC, lastSyncTime, fsrsParams }` |
| `lk:c:{hash}` | JSON | Card: `{ _url, note, hlc, dirty }` |
| `lk:card-index` | JSON array | Index: `[{ url, due, hash }]` |
| `lk:queue` | JSON array | Outgoing sync queue |
| `lk:token` | string | API token (fallback for Safari/Stay) |
| `lk:preferences` | JSON | Cached preferences: `{ data, ts }` |
| `lk:note:{url}` | JSON | API response cache (10 min TTL) |
| `lk:markers:{url}` | JSON | Video speed markers: `{ markers, dirty }` |
| `lianki_pos` | JSON | FAB button position `{ x, y }` |

**Capacity**: Max 2000 cards. On overflow, the card with the furthest due date (LDF) is evicted.

**Hash collision guard**: Each card record stores `_url`. On read, if `_url` doesn't match the requested URL, `getCard()` returns `null`.

### 2. Site Storage — IndexedDB `lianki-keyval`

A read-only mirror of Script Storage. Exists only on `lianki.com` so the web app's `/list` page can display local cards without accessing `GM_setValue` directly.

| Key | Value |
|---|---|
| `card:{url}` | `{ url, title, card, log, hlc, synced }` |
| `meta:gm-count` | Total number of cards in GM |

`synced` = `!dirty`. It reflects whether the card has been pushed to the server.

**Written by**: `syncToSiteDB()` — runs once at page load on any `lianki.com` page.

### 3. Cloud — MongoDB

Per-user collections named `FSRSNotes@{email}`.

```typescript
{
  _id: ObjectId,
  url: string,           // normalized, unique key
  title?: string,
  card: Card,            // ts-fsrs card state
  log?: ReviewLog[],     // full review history (appended, never overwritten)
  notes?: string,        // user notes (max 128 chars)
  speedMarkers?: Record<number, number>,
  hlc?: HLC,
}
```

---

## Hybrid Logical Clock (HLC)

```typescript
type HLC = {
  timestamp: number;  // Date.now() ms
  counter: number;    // logical counter for sub-millisecond ordering
  deviceId: string;   // "server" or UUID of device
}
```

**Comparison** (`compareHLC(a, b)`):
1. Higher `timestamp` wins.
2. Tie: higher `counter` wins.
3. Tie: `deviceId` string comparison (alphabetic).
4. Either being `null`/`undefined`: the other wins. Both null: tie.

**Generation** (`newHLC(deviceId, lastHLC?)`):
- If `Date.now() > lastHLC.timestamp`: new `{ timestamp: now, counter: 0, deviceId }`.
- If same millisecond: increment `counter`.

---

## Sync Directions

```
GM_setValue  ──syncToSiteDB()──►  IndexedDB (lianki.com only)
    │
    │  tryBackgroundSync() / queue
    ▼
  Server (MongoDB)
    │
    │  prefetchDueCards() (server → GM on page load)
    └──────────────────────────────────────────►  GM_setValue
```

### GM → IndexedDB (`syncToSiteDB`)

Runs at `document-end` on `lianki.com`. Reads entire GM index, writes each card to IDB. One-directional. IDB is never written back to GM.

### GM → Server (background sync queue)

Cards are marked `dirty = true` after any local review. A queue item is added for each action:

| Action | API call |
|---|---|
| `add` | `POST /api/fsrs/add` |
| `review` | `POST /api/fsrs/review/{rating}` with HLC in body |
| `delete` | `GET /api/fsrs/delete?id={noteId}` |
| `sync` | `GET /api/fsrs/get?url={url}` |

`tryBackgroundSync()` processes the queue sequentially every 30 s, or immediately on `navigator.onLine` event. Items are retried up to 5 times before being dropped.

### Server → GM (`prefetchDueCards`)

Runs 2 s after page init and after each review. Fetches 20 due cards from `/api/fsrs/due?limit=20`. For each card:

```
existing = cardStorage.getCard(url)
if (!existing || compareHLC(serverCard.hlc, existing.hlc) > 0)
  cardStorage.setCard(url, serverCard, serverCard.hlc, dirty=false)
```

Only overwrites local data if the server HLC is strictly newer.

---

## Write Paths

### Add card (online)

```
addNote(url, title)
  → POST /api/fsrs/add
  → MongoDB upsert (hlc = newServerHLC)
  → response: note + hlc
  → GM: setCard(url, note, note.hlc ?? newHLC(deviceId), dirty=false)
```

### Add card (offline / guest 401)

```
addNote() → 401
  → localNote = { _id: "local:{hash}", card: newCard(), hlc: newHLC(deviceId) }
  → GM: setCard(url, localNote, hlc, dirty=true)
  → queue: addToQueue("add", { url, title }, hlc)
  → (syncs when online)
```

### Review (cached card — offline-first path)

```
doReviewOffline(rating)
  → cachedCard = getCard(url)           // from GM
  → appliedCard = localFSRS.applyReview(cachedCard.card, rating)
  → newHlc = newHLC(deviceId, cachedCard.hlc)
  → GM: setCard(url, updatedNote, newHlc, dirty=true)
  → queue: addToQueue("review", { url, noteId, rating }, newHlc)
  → tryBackgroundSync()
```

### Review (no cached card — server fallback)

```
doReviewOffline(rating)
  → no cached card → falls through to original submitReview()
  → GET /api/fsrs/review/{rating}?id={noteId}
  → server applies FSRS, saves to MongoDB
  → response: { card, log, hlc, nextUrl }
```

### Review synced to server (background)

```
syncQueueItem({ action: "review", ... })
  → POST /api/fsrs/review/{rating} with body { hlc: clientHLC }
  → server: compareHLC(clientHLC, serverHLC)
    → clientHLC < serverHLC: 409 Conflict (server newer, drop queue item)
    → clientHLC >= serverHLC: accept, MongoDB $set { card, hlc }, $push { log }
```

### Delete (local-only card)

```
doDelete() + noteId starts with "local:"
  → cardStorage.deleteCard(url)
  → (no server call, no queue item)
```

### Delete (synced card)

```
doDelete()
  → cardStorage.deleteCard(url)
  → queue: addToQueue("delete", { url, noteId }, newHLC())
  → (background sync: GET /api/fsrs/delete?id={noteId})
```

---

## Edge Cases

### Case 1: Card reviewed offline, then server prefetch runs

**Scenario**: User reviews card A offline (sets `dirty=true`, new HLC at `now`). A few seconds later, `prefetchDueCards()` fetches card A from server (server still has old state, HLC older than `now`).

**Resolution**: `compareHLC(serverOldHlc, localNowHlc) < 0` → server loses → local state preserved. ✅

**Before fix (bug v2.21.10)**: If the card was initially cached via the online fallback path with `hlc=null`, then after review `newHLC(deviceId, null)` still produced a valid clock. The prefetch would have correctly lost. _However_, if the card was cached but **not yet reviewed**, the null HLC meant `compareHLC(serverHlc, null) > 0` → server overwrote the cached card. This could reset card state if the IDB-cached card was then opened.

**Fix (v2.21.11)**: Online fallback caching now uses `note.hlc ?? newHLC(deviceId, null)` instead of `null`.

---

### Case 2: Same card reviewed on two devices while offline

**Scenario**:
- Device A reviews card at t=100, HLC `{ timestamp:100, counter:0, deviceId:"A" }`.
- Device B reviews same card at t=100, HLC `{ timestamp:100, counter:0, deviceId:"B" }`.
- Both come online and try to sync.

**Resolution**:
- First device to sync wins (server accepts, stores HLC).
- Second device syncs with older HLC → server returns 409.
- Client drops the 409'd queue item (server version kept).
- Client's local GM state is NOT automatically corrected — it will be corrected next `prefetchDueCards()` when server version wins.

**Result**: Last-write-wins on the server. Local GM may temporarily show the device's own reviewed state until next prefetch.

---

### Case 3: Card exists in GM but not on server (e.g., account switch)

**Scenario**: User clears account data on server, but GM still holds cards from old session.

**Resolution**:
- `prefetchDueCards()` won't return deleted cards.
- On review, `syncQueueItem("review")` will fail with "note not found".
- After 5 retries the queue item is dropped.
- The card persists locally in GM (dirty=true) with no server counterpart.
- `queueStorage.addToQueue("add", ...)` is not re-queued automatically.

**Gap**: No reconciliation path exists to re-add cards orphaned this way.

---

### Case 4: Card exists on server but not in GM (new device / cleared storage)

**Scenario**: User uses a fresh device or clears Tampermonkey storage.

**Resolution**:
- `prefetchDueCards()` fetches top-20 due cards on first page load.
- Cards beyond rank 20 are not cached until they become due enough to enter top-20.
- Full restoration happens incrementally over many sessions.

**Gap**: No one-time full-sync on first install.

---

### Case 5: Card in GM (dirty) and card on server (newer HLC)

**Scenario**: Device A reviewed card, queued sync. Before sync, another device also reviewed and synced. Device A now tries to sync its stale review.

**Resolution**:
- Server receives Device A's review with `clientHLC`.
- `compareHLC(clientHLC, serverHLC) < 0` → 409 returned.
- Client drops the queue item.
- Device A's local GM still has its own review state until next `prefetchDueCards()` overwrites it.

**Implication**: The server holds the authoritative state. The review from Device A is silently discarded.

---

### Case 6: GM has data, IndexedDB is empty (navigated to lianki.com for first time)

**Scenario**: User has been using the userscript for months, opens `/list` page for the first time.

**Resolution**:
- `syncToSiteDB()` runs at page load, copies all GM cards to IDB.
- `/list` page reads from IDB.
- IDB is fully populated on first load.

**Expected behaviour**: List page shows all local cards immediately. ✅

---

### Case 7: GM is empty, IndexedDB has stale data

**Scenario**: User reinstalled Tampermonkey / cleared GM storage. IDB on lianki.com still has old data.

**Resolution**:
- `syncToSiteDB()` runs and overwrites IDB with empty GM data.
- `/list` page shows 0 local cards.

**Gap**: No warning shown to user that GM storage was cleared. Cards appear to have disappeared.

---

### Case 8: Guest mode (no auth), card reviewed, user later signs in

**Scenario**: User reviews cards offline without account. Later creates an account.

**Resolution**:
- All reviewed cards are in GM as `dirty=true` with `_id: "local:{hash}"`.
- Queue holds `"add"` and `"review"` items.
- On sign-in, `tryBackgroundSync()` runs.
- `"add"` items create cards on server with `noteId` from response replacing `"local:..."`.
- **Gap**: `"review"` items in queue still reference `noteId: "local:..."`. Server will reject them as "note not found" → dropped after 5 retries.
- Result: Cards are added to server but reviews are lost. Server sees them as new cards.

---

### Case 9: URL redirect changes the normalized URL

**Scenario**: Card saved for `https://example.com/page?ref=twitter`. User visits same page from `https://example.com/page?ref=google`. `normalizeUrl()` strips tracking params, both normalize to `https://example.com/page` — they match correctly.

**Scenario 2**: Card saved for `https://example.com/old-path`. Page permanently redirects to `https://example.com/new-path`. Userscript shows dialog, user confirms URL update.

**Resolution**:
- `checkRedirect()` detects the final URL differs from stored card URL.
- User is prompted.
- On confirm: `PATCH /api/fsrs/update-url { oldUrl, newUrl }`.
- MongoDB: updates `url` field. GM: deletes old key, saves under new URL.

---

### Case 10: GM storage full (2000 cards), new card added

**Scenario**: User has 2000 cards cached. Navigates to a new page.

**Resolution**:
- `setCard()` checks `_index().length >= MAX_CARDS`.
- LDF (Least Due First / Furthest Due) eviction: the card with the latest `due` date is removed.
- The new card is stored.

**Risk**: If the evicted card was `dirty`, its pending reviews are lost from GM. The queue still holds the review action, so the server sync may still succeed if queue item hasn't expired.

---

### Case 11: Network available but server returns 500

**Scenario**: Server error during background sync.

**Resolution**:
- `syncQueueItem()` catches the error.
- `retries` incremented.
- Item retried next cycle (30 s).
- After 5 failures: item dropped, review permanently lost.

**No user notification** is shown for silent background sync failures.

---

### Case 12: Two consecutive reviews of same card before sync

**Scenario**: User rates Again (card gets 1 min interval), waits 1 min, rates Good — all before any background sync.

**Resolution**:
- First review: `setCard(url, card1, hlc1, dirty=true)`, queue item 1 added.
- Second review: `setCard(url, card2, hlc2, dirty=true)`, queue item 2 added.
- Background sync processes item 1 first: server applies first review.
- Server processes item 2 next: `compareHLC(hlc2, serverHlc_after_item1)`.
  - If `hlc2 > serverHlc`: accepted. ✅
  - If `hlc2 < serverHlc`: 409. Both reviews survive on server but second is dropped on client.
- **Expected**: Both reviews accepted in order (HLC is monotonically increasing per device).

---

## Sync Flow Diagram

```
Page Load
    │
    ├─── syncToSiteDB()  ─────────────────────────────►  IDB (lianki.com only)
    │
    ├─── After 2s: prefetchDueCards() ◄──────────────── GET /api/fsrs/due?limit=20
    │         │
    │         └── compareHLC(server, local)
    │               server newer: overwrite GM
    │               local newer: keep GM
    │
    └─── openDialogOffline()
              │
              ├── card in GM?
              │     YES → show options from local FSRS calc
              │     NO  → addNote() online
              │              └── 401 → create local card (guest mode)
              │
              └── doReviewOffline(rating)
                        │
                        ├── apply FSRS locally
                        ├── setCard(dirty=true)
                        ├── addToQueue("review")
                        ├── find next card from getDueCards()
                        └── tryBackgroundSync()
                                  │
                                  └── POST /api/fsrs/review/{rating}
                                            │
                                            ├── clientHLC < serverHLC → 409, drop
                                            └── clientHLC >= serverHLC → accept
```

---

## Known Gaps

| Gap | Impact | Workaround |
|---|---|---|
| No full-sync on first install | Only top-20 due cards cached | Cards populate incrementally |
| Guest review IDs not updated after sign-in | Reviews lost on first sync | None currently |
| No user notification on sync failure | Silent data loss after 5 retries | Check `/list` page sync indicator |
| Dirty card evicted from full GM cache | Review in queue but card state lost locally | Queue still syncs if server is reachable |
| No reconciliation for server-deleted cards | Orphaned dirty cards in GM forever | Manual Tampermonkey storage clear |
| IDB not written back to GM | IDB is read-only mirror | By design — GM is source of truth |
