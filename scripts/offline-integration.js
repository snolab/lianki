/**
 * Offline-First Integration for lianki.user.js
 *
 * This code is inserted into main() to wire up offline functionality.
 * It modifies openDialog() and doReview() to use IndexedDB cache.
 */

// ── Offline Storage Initialization ──────────────────────────────────────────
let offlineReady = false;
let cardStorage, configStorage, queueStorage, localFSRS;
const deviceId = getOrCreateDeviceId();
let syncInProgress = false;
let syncTimer = null;

// Initialize offline storage
async function initOfflineStorage() {
  try {
    const stores = initStores();
    cardStorage = new CardStorage(stores, deviceId);
    configStorage = new ConfigStorage(stores);
    queueStorage = new QueueStorage(stores);

    // Load FSRS parameters
    const config = await configStorage.getConfig();
    localFSRS = new LocalFSRS(config.fsrsParams);

    offlineReady = true;
    console.log("[Lianki] Offline storage initialized");

    // Start background sync loop
    startBackgroundSync();

    // Prefetch due cards in background
    setTimeout(() => prefetchDueCards(), 2000);
  } catch (err) {
    console.error("[Lianki] Failed to initialize offline storage:", err);
    // Graceful degradation - continue with online-only mode
  }
}

// ── Modified openDialog (Offline-First) ─────────────────────────────────────
const _originalOpenDialog = openDialog;
openDialog = async function openDialogOffline() {
  if (dialog) return;

  dialog = mountDialog();
  state = { phase: "adding", noteId: null, options: null, error: null, message: null };
  prefetchedNextUrl = null;
  renderDialog();
  dialog.focus();

  const url = normalizeUrl(location.href);

  // Offline-first: Check IndexedDB cache
  if (offlineReady) {
    try {
      const cachedCard = await cardStorage.getCard(url);

      if (cachedCard) {
        console.log("[Lianki] Using cached card");

        // Instant review from cache!
        state.noteId = cachedCard.note._id;
        state.notes = cachedCard.note.notes ?? "";
        state.notesSynced = !cachedCard.dirty;
        state.phase = "reviewing";
        state.options = localFSRS.calculateOptions(cachedCard.note.card);
        renderDialog();

        // Background: Ensure server has latest (if online)
        if (navigator.onLine && cachedCard.dirty) {
          queueStorage.addToQueue("sync", { url }, cachedCard.hlc);
          tryBackgroundSync();
        }

        // Background: Prefetch next card
        setTimeout(() => prefetchNextCachedCard(), 100);

        return;
      }
    } catch (err) {
      console.error("[Lianki] Cache check failed:", err);
      // Fall through to online mode
    }
  }

  // Fallback: Original online behavior
  addNote(url, document.title)
    .then(async (note) => {
      state.noteId = note._id;
      state.notes = note.notes ?? "";
      state.notesSynced = true;

      // Save to cache
      if (offlineReady) {
        try {
          await cardStorage.setCard(url, note);
        } catch (err) {
          console.error("[Lianki] Failed to cache card:", err);
        }
      }

      // Prefetch next URL in background while user reviews this card
      getNextUrl()
        .then((data) => {
          prefetchedNextUrl = data.url;
          if (data.url) prefetchNextPage(data.url);
        })
        .catch(() => {});

      // Use options from add-card response if available (optimization)
      if (note.options) {
        return { options: note.options };
      }

      // Or calculate locally if we have FSRS params
      if (offlineReady && localFSRS) {
        return { options: localFSRS.calculateOptions(note.card) };
      }

      // Fallback for older API versions
      return getOptions(note._id);
    })
    .then((data) => {
      state.phase = "reviewing";
      state.options = data.options;
      renderDialog();
    })
    .catch((err) => {
      state.phase = "error";
      state.error = err.message;
      state.errorDetails = err.details ?? null;
      renderDialog();
    });
};

// ── Modified doReview (Offline-First) ───────────────────────────────────────
const _originalDoReview = doReview;
doReview = async function doReviewOffline(rating) {
  if (state.phase !== "reviewing" || !state.noteId) return;

  const url = normalizeUrl(location.href);

  // Offline-first: Update locally
  if (offlineReady) {
    try {
      const cachedCard = await cardStorage.getCard(url);

      if (cachedCard && localFSRS) {
        console.log("[Lianki] Applying review locally");

        // Apply review with ts-fsrs
        const reviewResult = localFSRS.applyReview(cachedCard.note.card, rating);

        // Update card
        cachedCard.note.card = reviewResult.card;
        cachedCard.note.log = cachedCard.note.log || [];
        cachedCard.note.log.push(reviewResult.log);

        // Update HLC
        const newHlc = newHLC(deviceId, cachedCard.hlc);
        await cardStorage.setCard(url, cachedCard.note, newHlc, true); // dirty = true

        // Queue for server sync
        await queueStorage.addToQueue(
          "review",
          {
            url,
            noteId: state.noteId,
            rating,
          },
          newHlc,
        );

        // Instant feedback!
        const opt = state.options.find((o) => Number(o.rating) === rating);
        await afterReview(`Reviewed! Next due: ${opt?.due ?? "?"}`);

        // Background sync
        tryBackgroundSync();

        return;
      }
    } catch (err) {
      console.error("[Lianki] Local review failed:", err);
      // Fall through to online mode
    }
  }

  // Fallback: Original online behavior
  try {
    const result = await submitReview(state.noteId, rating);

    // Update cache if available
    if (offlineReady && result.card) {
      try {
        const cachedCard = await cardStorage.getCard(url);
        if (cachedCard) {
          cachedCard.note.card = result.card;
          cachedCard.note.log = result.log || cachedCard.note.log;
          await cardStorage.setCard(url, cachedCard.note, result.hlc);
        }
      } catch (err) {
        console.error("[Lianki] Failed to update cache:", err);
      }
    }

    // Use nextUrl from review response if available (optimization)
    if (result.nextUrl) {
      prefetchedNextUrl = result.nextUrl;
      prefetchNextPage(result.nextUrl);
    }

    const opt = state.options.find((o) => Number(o.rating) === rating);
    await afterReview(`Reviewed! Next due: ${opt?.due ?? "?"}`);
  } catch (err) {
    state.phase = "error";
    state.error = err.message;
    state.errorDetails = err.details ?? null;
    renderDialog();
  }
};

// ── Background Sync ──────────────────────────────────────────────────────────
function startBackgroundSync() {
  // Sync every 30 seconds
  syncTimer = setInterval(() => {
    if (navigator.onLine && !syncInProgress) {
      tryBackgroundSync();
    }
  }, 30000);

  // Sync when coming online
  window.addEventListener("online", () => {
    console.log("[Lianki] Network online - starting sync");
    tryBackgroundSync();
  });

  // Initial sync
  setTimeout(() => tryBackgroundSync(), 5000);
}

async function tryBackgroundSync() {
  if (syncInProgress || !offlineReady) return;
  if (!navigator.onLine) {
    console.log("[Lianki] Offline - will sync when online");
    return;
  }

  syncInProgress = true;

  try {
    const queue = await queueStorage.getQueue();

    if (queue.length === 0) {
      syncInProgress = false;
      return;
    }

    console.log(`[Lianki] Syncing ${queue.length} pending updates...`);

    // Sync in order (HLC sorted)
    for (const item of queue) {
      try {
        await syncQueueItem(item);
        await queueStorage.removeFromQueue(item.id);
        console.log(`[Lianki] Synced: ${item.action} ${item.data.url || item.data.noteId}`);
      } catch (err) {
        console.error(`[Lianki] Sync failed for ${item.id}:`, err);

        // Increment retry count
        item.retries = (item.retries || 0) + 1;

        if (item.retries > 5) {
          console.warn(`[Lianki] Dropping ${item.id} after 5 retries`);
          await queueStorage.removeFromQueue(item.id);
        } else {
          await queueStorage.updateQueueItem(item.id, { retries: item.retries });
        }
      }
    }

    // Update last sync time
    await configStorage.updateLastSync(newHLC(deviceId, null));

    console.log("[Lianki] Sync complete");
  } finally {
    syncInProgress = false;
  }
}

async function syncQueueItem(item) {
  switch (item.action) {
    case "review":
      await api(
        `/api/fsrs/review/${item.data.rating}/?id=${encodeURIComponent(item.data.noteId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hlc: item.hlc }),
        },
      );
      break;

    case "add":
      await addNote(item.data.url, item.data.title);
      break;

    case "delete":
      await deleteNote(item.data.noteId);
      break;

    case "sync":
      // Just verify card is on server
      await api(`/api/fsrs/get?url=${encodeURIComponent(item.data.url)}`);
      break;
  }
}

// ── Prefetch Due Cards ───────────────────────────────────────────────────────
async function prefetchDueCards() {
  if (!offlineReady || !navigator.onLine) return;

  try {
    console.log("[Lianki] Prefetching due cards...");

    const response = await api("/api/fsrs/due?limit=20");
    const dueCards = response.cards || [];

    for (const note of dueCards) {
      try {
        const url = note.url;
        const existing = await cardStorage.getCard(url);

        // Update if server version is newer or doesn't exist
        if (!existing || compareHLC(note.hlc, existing.hlc) > 0) {
          await cardStorage.setCard(
            url,
            note,
            note.hlc || newHLC("server", null),
            false, // not dirty
          );
        }
      } catch (err) {
        console.error(`[Lianki] Failed to cache card ${note.url}:`, err);
      }
    }

    console.log(`[Lianki] Prefetched ${dueCards.length} cards`);
  } catch (err) {
    console.error("[Lianki] Prefetch failed:", err);
  }
}

async function prefetchNextCachedCard() {
  if (!offlineReady) return;

  try {
    const dueCards = await cardStorage.getDueCards(1);
    if (dueCards.length > 0 && dueCards[0].url !== location.href) {
      prefetchNextPage(dueCards[0].url);
    }
  } catch (err) {
    console.error("[Lianki] Failed to prefetch next cached card:", err);
  }
}

// ── Render Sync Status ───────────────────────────────────────────────────────
const _originalRenderDialog = renderDialog;
renderDialog = function renderDialogWithSync() {
  _originalRenderDialog();

  // Add sync status indicator
  if (dialog && offlineReady) {
    const indicator = document.createElement("div");
    Object.assign(indicator.style, {
      position: "absolute",
      top: "8px",
      right: "8px",
      fontSize: "11px",
      opacity: "0.6",
      display: "flex",
      alignItems: "center",
      gap: "4px",
    });

    (async () => {
      const queue = await queueStorage.getQueue();
      const queueCount = queue.length;

      if (!navigator.onLine) {
        indicator.textContent = "📴 Offline";
      } else if (syncInProgress) {
        indicator.textContent = "🔄 Syncing...";
      } else if (queueCount > 0) {
        indicator.textContent = `⏳ ${queueCount}`;
      } else {
        indicator.textContent = "✓";
      }

      dialog.appendChild(indicator);
    })();
  }
};

// ── Initialize on startup ────────────────────────────────────────────────────
// Call after api() is defined
setTimeout(() => {
  initOfflineStorage().catch((err) => {
    console.error("[Lianki] Offline initialization failed:", err);
  });
}, 100);
