# Offline-First Userscript Plan

## Goals

1. **Instant reviews** - No network latency, calculate FSRS locally
2. **Offline capability** - Full review functionality without internet
3. **CRDT sync** - Conflict-free synchronization across devices
4. **Prefetch intelligence** - Cache full deck in IndexedDB

## Architecture

### Storage Layer (IndexedDB)

```typescript
// Store: 'cards'
{
  url: string,           // Primary key
  note: FSRSNote,        // Full card data
  hlc: HLC,              // Hybrid Logical Clock
  dirty: boolean         // Has pending server sync
}

// Store: 'config'
{
  fsrsParams: Parameters, // User's FSRS parameters
  deviceId: string,       // UUID for this device
  lastSyncHLC: HLC,       // Last successful sync
  lastSyncTime: number    // Last sync timestamp
}

// Store: 'queue'
{
  id: string,            // UUID
  url: string,           // Card URL
  action: 'review' | 'add' | 'delete' | 'update',
  data: any,             // Action-specific data
  hlc: HLC,              // When this action occurred
  retries: number        // Sync retry count
}
```

### Hybrid Logical Clock (HLC)

```typescript
type HLC = {
  timestamp: number; // Physical clock (Date.now())
  counter: number; // Logical counter for same timestamp
  deviceId: string; // Device identifier
};

// HLC comparison: timestamp > counter > deviceId
function compareHLC(a: HLC, b: HLC): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId.localeCompare(b.deviceId);
}

// Generate new HLC
function newHLC(deviceId: string, lastHLC: HLC | null): HLC {
  const now = Date.now();
  if (!lastHLC || now > lastHLC.timestamp) {
    return { timestamp: now, counter: 0, deviceId };
  }
  // Same timestamp - increment counter
  return { timestamp: lastHLC.timestamp, counter: lastHLC.counter + 1, deviceId };
}
```

### Dependencies

**Bundle additions** (~70KB total):

- `ts-fsrs` (~50KB) - FSRS algorithm implementation
- `idb-keyval` (~1KB) - Lightweight IndexedDB wrapper
- HLC implementation (~2KB) - Custom CRDT logic

## Implementation Steps

### 1. Setup IndexedDB Layer

```javascript
// Using idb-keyval for simplicity
import { createStore, get, set, keys, del } from "idb-keyval";

const cardStore = createStore("lianki-cards", "cards");
const configStore = createStore("lianki-config", "config");
const queueStore = createStore("lianki-queue", "queue");

// Helpers
async function getCard(url) {
  return await get(url, cardStore);
}

async function setCard(url, card) {
  await set(url, card, cardStore);
}

async function getAllCards() {
  const urls = await keys(cardStore);
  return Promise.all(urls.map((url) => getCard(url)));
}
```

### 2. Bundle ts-fsrs

```javascript
// Minified ts-fsrs bundle (inline in userscript)
// Generated via: bun build --minify --target=browser
import { fsrs, generatorParameters, Rating } from "ts-fsrs";

// Initialize FSRS scheduler
let fsrsScheduler = null;
let fsrsParams = null;

async function initFSRS() {
  const config = await get("config", configStore);
  fsrsParams = config?.fsrsParams || generatorParameters({});
  fsrsScheduler = fsrs(fsrsParams);
}

// Calculate review options locally
function calculateOptions(card) {
  if (!fsrsScheduler) throw new Error("FSRS not initialized");

  const now = new Date();
  return [
    { rating: 1, ...fsrsScheduler.repeat(card, now)[Rating.Again] },
    { rating: 2, ...fsrsScheduler.repeat(card, now)[Rating.Hard] },
    { rating: 3, ...fsrsScheduler.repeat(card, now)[Rating.Good] },
    { rating: 4, ...fsrsScheduler.repeat(card, now)[Rating.Easy] },
  ];
}
```

### 3. Offline-First Review Flow

```javascript
async function openDialog() {
  const url = normalizeUrl(location.href);

  // 1. Check IndexedDB first
  let cardData = await getCard(url);

  if (cardData) {
    // Card exists locally - instant review!
    state.noteId = cardData.note._id;
    state.phase = "reviewing";
    state.options = calculateOptions(cardData.note.card);
    renderDialog();

    // Background: ensure server has latest
    queueAction("sync", { url });
    tryBackgroundSync();
  } else {
    // Card not cached - fetch from server
    state.phase = "loading";
    renderDialog();

    try {
      const note = await addNote(url, document.title);

      // Save to IndexedDB
      const hlc = newHLC(deviceId, null);
      await setCard(url, {
        note,
        hlc,
        dirty: false,
      });

      // Calculate locally
      state.noteId = note._id;
      state.phase = "reviewing";
      state.options = calculateOptions(note.card);
      renderDialog();
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      renderDialog();
    }
  }

  // Background: prefetch next 10 due cards
  prefetchDueCards();
}
```

### 4. Local Review Submission

```javascript
async function doReview(rating) {
  if (state.phase !== "reviewing" || !state.noteId) return;

  const url = normalizeUrl(location.href);
  const cardData = await getCard(url);

  if (!cardData) {
    // Fallback to server
    return doReviewServer(rating);
  }

  // Update card locally with ts-fsrs
  const now = new Date();
  const reviewResult = fsrsScheduler.repeat(cardData.note.card, now)[rating];

  cardData.note.card = reviewResult.card;
  cardData.note.log = cardData.note.log || [];
  cardData.note.log.push(reviewResult.log);
  cardData.hlc = newHLC(deviceId, cardData.hlc);
  cardData.dirty = true;

  // Save updated card
  await setCard(url, cardData);

  // Queue server sync
  await queueAction("review", {
    url,
    noteId: state.noteId,
    rating,
    hlc: cardData.hlc,
  });

  // Instant feedback!
  const opt = state.options.find((o) => Number(o.rating) === rating);
  await afterReview(`Reviewed! Next due: ${opt?.due ?? "?"}`);

  // Background sync
  tryBackgroundSync();
}
```

### 5. Background Sync

```javascript
let syncInProgress = false;
let syncRetryTimeout = null;

async function tryBackgroundSync() {
  if (syncInProgress) return;
  if (!navigator.onLine) {
    console.log("[Lianki] Offline - will sync when online");
    return;
  }

  syncInProgress = true;

  try {
    // Get all queued actions
    const queueKeys = await keys(queueStore);
    const queue = await Promise.all(queueKeys.map((k) => get(k, queueStore)));

    if (queue.length === 0) {
      syncInProgress = false;
      return;
    }

    // Sync in batches
    for (const action of queue) {
      try {
        await syncAction(action);
        await del(action.id, queueStore);
      } catch (err) {
        console.error("[Lianki] Sync failed:", err);
        action.retries = (action.retries || 0) + 1;

        if (action.retries > 5) {
          // Too many retries - drop it
          await del(action.id, queueStore);
        } else {
          // Update retry count
          await set(action.id, action, queueStore);
        }
      }
    }

    // Update last sync time
    const config = await get("config", configStore);
    config.lastSyncTime = Date.now();
    await set("config", config, configStore);
  } finally {
    syncInProgress = false;
  }

  // Retry in 30s if there are still queued items
  const remaining = await keys(queueStore);
  if (remaining.length > 0) {
    syncRetryTimeout = setTimeout(tryBackgroundSync, 30000);
  }
}

// Sync single action to server
async function syncAction(action) {
  switch (action.action) {
    case "review":
      await api(
        `/api/fsrs/review/${action.data.rating}/?id=${encodeURIComponent(action.data.noteId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hlc: action.hlc }),
        },
      );
      break;

    case "add":
      await addNote(action.data.url, action.data.title);
      break;

    case "delete":
      await deleteNote(action.data.noteId);
      break;
  }
}
```

### 6. Prefetch Due Cards

```javascript
async function prefetchDueCards() {
  try {
    // Fetch next 10 due cards from server
    const response = await api("/api/fsrs/due?limit=10");
    const dueCards = response.cards || [];

    // Save to IndexedDB
    for (const note of dueCards) {
      const existing = await getCard(note.url);

      if (!existing || compareHLC(note.hlc, existing.hlc) > 0) {
        // Server version is newer
        await setCard(note.url, {
          note,
          hlc: note.hlc || newHLC("server", null),
          dirty: false,
        });
      }
    }

    console.log(`[Lianki] Prefetched ${dueCards.length} due cards`);
  } catch (err) {
    console.error("[Lianki] Prefetch failed:", err);
  }
}
```

### 7. Sync Status Indicator

```javascript
// Add sync indicator to dialog
function renderSyncStatus() {
  const indicator = document.createElement('div');
  indicator.style.cssText = `
    position: absolute;
    top: 8px;
    right: 8px;
    font-size: 11px;
    opacity: 0.6;
  `;

  if (!navigator.onLine) {
    indicator.textContent = '📴 Offline';
  } else if (syncInProgress) {
    indicator.textContent = '🔄 Syncing...';
  } else {
    const queueCount = await keys(queueStore).then(k => k.length);
    if (queueCount > 0) {
      indicator.textContent = `⏳ ${queueCount} pending`;
    } else {
      indicator.textContent = '✓ Synced';
    }
  }

  return indicator;
}
```

## Server-Side Changes

### New API Endpoints

**GET /api/fsrs/due?limit=10**

```typescript
// Returns next N due cards with HLC timestamps
{
  cards: FSRSNote[]  // Each includes hlc field
}
```

**POST /api/fsrs/review/:rating**

```typescript
// Accept HLC in body for conflict resolution
body: {
  hlc: HLC;
}

// Server compares HLC:
// - If server HLC > client HLC: reject, return latest
// - If client HLC > server HLC: accept, update
// - Save client HLC with card
```

**GET /api/fsrs/sync**

```typescript
// Full sync endpoint
query: { since: timestamp }

// Returns all cards modified since timestamp
{
  cards: FSRSNote[],
  deletions: string[],  // Deleted URLs
  serverHLC: HLC
}
```

### Database Schema Updates

```typescript
// Add HLC to FSRSNote
type FSRSNote = {
  // ... existing fields
  hlc?: HLC; // Hybrid Logical Clock
  deviceId?: string; // Last device that modified
};
```

## Testing Plan

1. **Offline Review**
   - Load page with cached card
   - Disconnect network
   - Open dialog → should show review instantly
   - Submit review → should queue for sync
   - Reconnect → should sync automatically

2. **Conflict Resolution**
   - Review card on device A
   - Review same card on device B (offline)
   - Reconnect device B → HLC should resolve conflict

3. **Prefetch**
   - Complete review
   - Check IndexedDB → should have 10 due cards
   - Open any prefetched card → instant review

4. **Error Handling**
   - Server returns 500 → should retry
   - Server returns 409 conflict → should fetch latest
   - Network timeout → should fallback to cache

## Bundle Size Impact

**Before**: ~50KB
**After**: ~120KB (+70KB)

Breakdown:

- ts-fsrs: 50KB
- idb-keyval: 1KB
- HLC + sync logic: 10KB
- Buffer for minification: 9KB

Still acceptable for userscript loaded once and cached by extension.

## Migration

**First load with new version**:

1. Initialize IndexedDB stores
2. Generate deviceId (UUID)
3. Fetch user's FSRS parameters
4. Fetch due cards (prefetch)
5. Set lastSyncTime

**Backward compatibility**:

- Old API endpoints still work
- HLC is optional (server generates if missing)
- Graceful degradation if IndexedDB unavailable

## Performance Gains

**Before** (network-dependent):

- Open dialog: ~500ms (network round-trip)
- Review card: ~500ms (network round-trip)
- Total: ~1000ms per review

**After** (offline-first):

- Open dialog: ~50ms (IndexedDB read)
- Review card: ~50ms (local calculation + queue)
- Total: ~100ms per review

**10x faster reviews!** 🚀

## Future Enhancements

1. **Service Worker**: Replace setTimeout sync with Background Sync API
2. **Compression**: Use CompressionStreams for large decks
3. **Partial sync**: Only sync changed fields, not full cards
4. **Conflict UI**: Show user when conflicts detected
5. **Export/Import**: Backup deck to JSON file
