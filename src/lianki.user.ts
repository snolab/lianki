// ==UserScript==
// @name        Lianki
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_info
// @version     2.23.31
// @author      lianki.com
// @description Lianki spaced repetition — offline-first with IndexedDB sync. Press , or . (or media keys) to control video speed with difficulty markers.
// @run-at      document-end
// @downloadURL https://lianki.com/lianki.user.js
// @updateURL   https://lianki.com/lianki.meta.js
// @connect     lianki.com
// @connect     www.lianki.com
// @connect     *
// ==/UserScript==

import { fsrs, generatorParameters, Rating } from "ts-fsrs";

declare const GM_xmlhttpRequest: Function;
declare const GM_setValue: (key: string, value: any) => void;
declare const GM_getValue: (key: string, defaultValue?: any) => any;
declare const GM_deleteValue: (key: string) => void;
declare const GM_info: { script: { version: string } };

if (window.self === window.top) {
  globalThis.unload_Lianki?.();
  globalThis.unload_Lianki = main();
}

/**
 * Offline-First Core for Lianki Userscript
 *
 * This file contains:
 * - Hybrid Logical Clock (HLC) implementation
 * - GM_setValue storage layer (LDF eviction, 2000 card cap)
 * - Local FSRS calculations
 * - Background sync mechanism
 */

// ============================================================================
// Hybrid Logical Clock (HLC) - CRDT Conflict Resolution
// ============================================================================

/**
 * @typedef {Object} HLC
 * @property {number} timestamp - Physical clock (Date.now())
 * @property {number} counter - Logical counter for same timestamp
 * @property {string} deviceId - Device/session identifier
 */

/**
 * Compare two HLC timestamps
 * Returns: < 0 if a < b, 0 if equal, > 0 if a > b
 */
function compareHLC(a, b) {
  if (!a) return -1;
  if (!b) return 1;
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId.localeCompare(b.deviceId);
}

/**
 * Generate new HLC timestamp
 */
function newHLC(deviceId, lastHLC = null) {
  const now = Date.now();

  if (!lastHLC || now > lastHLC.timestamp) {
    return { timestamp: now, counter: 0, deviceId };
  }

  // Same timestamp - increment counter
  return {
    timestamp: lastHLC.timestamp,
    counter: lastHLC.counter + 1,
    deviceId,
  };
}

/**
 * Generate device ID (persisted in GM_setValue)
 */
function getOrCreateDeviceId() {
  let deviceId = GM_getValue("lk:deviceId", "");

  if (!deviceId) {
    // Generate UUID v4
    deviceId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    GM_setValue("lk:deviceId", deviceId);
  }

  return deviceId;
}

// ============================================================================
// GM_setValue Storage Layer
// ============================================================================

// ── GM_setValue Storage Layer ────────────────────────────────────────────────

const CARD_PREFIX = "lk:c:";
const INDEX_KEY = "lk:card-index";

function hashUrl(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * Is a failed sync worth trying again?
 *
 * Most 4xx say the request itself is wrong and will stay wrong however many
 * times it is repeated — 409 means the server already has a newer version, 404
 * means the note is gone. Those must be dropped, or they jam the queue behind
 * them forever.
 *
 * The exceptions are the ones where the SAME request can succeed later:
 *
 *   401/403 — not signed in yet. A guest reviews cards before ever having an
 *             account; those reviews sit in the queue until they sign in. The
 *             first version of this dropped them, which silently destroyed the
 *             work of every signed-out user. The guest suite caught it.
 *   408/429 — timeout and rate limit, which literally mean "try again".
 *
 * No status at all is a network failure, and equally worth retrying.
 */
function isPermanentSyncFailure(status) {
  if (status === 401 || status === 403 || status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

class GMCardStorage {
  _index() {
    return JSON.parse(GM_getValue(INDEX_KEY, "[]"));
  }
  _saveIndex(idx) {
    GM_setValue(INDEX_KEY, JSON.stringify(idx));
  }

  getCard(url) {
    const raw = GM_getValue(CARD_PREFIX + hashUrl(url), "");
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c._url !== url) return null; // hash collision guard
    return c.deletedAt ? null : c;
  }

  /**
   * No card cap, and no eviction.
   *
   * This used to hold 2000 cards and, when full, delete the furthest-due one to
   * make room. That traded a bounded store for silent data loss: the evicted
   * card could be `dirty`, taking un-synced reviews with it, and the user was
   * never told. It was only ever survivable because the server held a full
   * copy — which stops being true the moment cloud sync is optional.
   *
   * The bound it bought was not worth much either: measured against real data,
   * a card is roughly 1.3 KB, so the cap guarded about 2.6 MB in an extension
   * store that handles far more.
   *
   * If a write genuinely fails (quota), the failure is surfaced and the index
   * is left untouched, so the store stays consistent and the card simply is not
   * cached locally — it still reaches the server through the sync queue. A
   * loud, recoverable failure on the NEW card beats silently deleting an old
   * one the user never chose to lose.
   */
  setCard(url, note, hlc, dirty = false) {
    const hash = hashUrl(url);
    const key = CARD_PREFIX + hash;
    const idx = this._index();
    const pos = idx.findIndex((e) => e.url === url);
    const entry = { url, due: note.card.due, hash }; // no `del`: writing a card undeletes it

    try {
      GM_setValue(key, JSON.stringify({ _url: url, note, hlc, dirty }));
    } catch (err) {
      // Prefixed so the dev loader's error sink forwards it (see
      // docs/dev-userscript-loader.md); otherwise it dies in a console nobody
      // is reading.
      console.error("[Lianki] could not store card locally:", url, err);
      return false;
    }

    if (pos >= 0) idx[pos] = entry;
    else idx.push(entry);
    this._saveIndex(idx);
    return true;
  }

  /**
   * Soft delete. Writes a tombstone instead of dropping the record.
   *
   * A hard delete flip-flops: the next prefetch sees no local copy, treats the
   * server's card as new, and puts it straight back — so deleting the same card
   * five times leaves it exactly where it was. The tombstone carries a fresh
   * HLC, so the merge in prefetchDueCards sees a LOCAL state that is NEWER than
   * the server's card and leaves it alone until the deletion reaches the server.
   *
   * Merge rules and the 90-day retention: docs/sync-merge-rules.md.
   */
  deleteCard(url) {
    const hash = hashUrl(url);
    const prev = this.getEntry(url);
    const idx = this._index();
    const pos = idx.findIndex((e) => e.url === url);
    const entry = { url, due: new Date(0).toISOString(), hash, del: 1 };
    if (pos >= 0) idx[pos] = entry;
    else idx.push(entry);
    this._saveIndex(idx);
    GM_setValue(
      CARD_PREFIX + hash,
      JSON.stringify({
        _url: url,
        note: null,
        hlc: newHLC(getOrCreateDeviceId(), prev?.hlc ?? null),
        dirty: true,
        deletedAt: Date.now(),
      }),
    );
  }

  deleteAllCards() {
    const idx = this._index();
    let n = 0;
    for (const e of idx) {
      if (e.del) continue;
      this.deleteCard(e.url);
      n++;
    }
    return n;
  }

  /** The raw record, tombstones included — merge decisions need to see them. */
  getEntry(url) {
    const raw = GM_getValue(CARD_PREFIX + hashUrl(url), "");
    if (!raw) return null;
    const c = JSON.parse(raw);
    return c._url === url ? c : null;
  }

  isDeleted(url) {
    return !!this.getEntry(url)?.deletedAt;
  }

  /**
   * Drop tombstones past the retention window. Until then they must stay: a
   * tombstone is the only thing that can outvote a stale server copy.
   */
  purgeExpiredTombstones(maxAgeMs = 90 * 86400_000) {
    const now = Date.now();
    const idx = this._index();
    const keep = [];
    let removed = 0;
    for (const e of idx) {
      if (e.del) {
        const rec = this.getEntry(e.url);
        if (!rec || now - (rec.deletedAt ?? 0) > maxAgeMs) {
          GM_deleteValue(CARD_PREFIX + e.hash);
          removed++;
          continue;
        }
      }
      keep.push(e);
    }
    if (removed) this._saveIndex(keep);
    return removed;
  }

  getAllCards() {
    return this._index()
      .filter((e) => !e.del)
      .map((e) => {
        const raw = GM_getValue(CARD_PREFIX + e.hash, "");
        return raw ? { url: e.url, ...JSON.parse(raw) } : null;
      })
      .filter(Boolean);
  }

  getDueCards(limit = 10) {
    const now = new Date();
    return (
      this._index()
        .filter((e) => !e.del && new Date(e.due) <= now)
        // Most recently due first, matching the server's NEXT_DUE_SORT. Offline
        // and online must agree, or the card you get depends on connectivity.
        .sort((a, b) => new Date(b.due) - new Date(a.due))
        .slice(0, limit)
        .map((e) => {
          const raw = GM_getValue(CARD_PREFIX + e.hash, "");
          return raw ? { url: e.url, ...JSON.parse(raw) } : null;
        })
        .filter(Boolean)
    );
  }
}

class GMConfigStorage {
  getConfig() {
    const cfg = JSON.parse(GM_getValue("lk:config", "{}"));
    if (!cfg.lastSyncHLC) cfg.lastSyncHLC = null;
    if (!cfg.lastSyncTime) cfg.lastSyncTime = 0;
    return cfg;
  }
  setConfig(cfg) {
    GM_setValue("lk:config", JSON.stringify(cfg));
  }
  updateLastSync(hlc) {
    this.setConfig({ ...this.getConfig(), lastSyncHLC: hlc, lastSyncTime: Date.now() });
  }
}

class GMQueueStorage {
  getQueue() {
    return JSON.parse(GM_getValue("lk:queue", "[]"));
  }
  addToQueue(action, data, hlc) {
    const q = this.getQueue();
    q.push({
      id: Date.now() + Math.random(),
      action,
      data,
      hlc,
      retries: 0,
      createdAt: Date.now(),
    });
    GM_setValue("lk:queue", JSON.stringify(q));
  }
  removeFromQueue(id) {
    GM_setValue("lk:queue", JSON.stringify(this.getQueue().filter((e) => e.id !== id)));
  }
  updateQueueItem(id, updates) {
    GM_setValue(
      "lk:queue",
      JSON.stringify(this.getQueue().map((e) => (e.id === id ? { ...e, ...updates } : e))),
    );
  }
}

// ============================================================================
// GM→IndexedDB Sync (runs on lianki.com to expose cached cards to site UI)
// ============================================================================

/**
 * Apply deletions the site queued for us (see lib/local-purge.ts).
 *
 * GM storage is the copy this script serves cards FROM, and nothing else can
 * reach it: the site can delete from the cloud and from its IndexedDB mirror and
 * still be handed the same card back, because syncToSiteDB rebuilds that mirror
 * from here.
 */
function drainPurgeQueue(cs) {
  let req;
  try {
    const raw = localStorage.getItem("lk:purge");
    if (!raw) return 0;
    req = JSON.parse(raw);
  } catch {
    return 0;
  }
  let removed = 0;
  try {
    if (req?.all) {
      removed = cs.deleteAllCards();
    } else if (Array.isArray(req?.urls)) {
      for (const url of req.urls) {
        // deleteCard writes a tombstone, so the next prefetch cannot undo this.
        // A hard delete here is what let the same card come back repeatedly.
        if (cs.getCard(url)) removed++;
        cs.deleteCard(url);
      }
    }
    localStorage.removeItem("lk:purge");
  } catch (err) {
    // Leave the queue in place: better to retry on the next visit than to drop
    // deletions and keep serving cards the user removed.
    console.error("[Lianki] purge failed:", err);
    return removed;
  }
  if (removed) console.log(`[Lianki] Purged ${removed} deleted cards from local storage`);
  return removed;
}

async function syncToSiteDB() {
  const cs = new GMCardStorage();
  drainPurgeQueue(cs);
  // Retention sweep. A tombstone older than the window can no longer be
  // outvoting anything useful; keeping it forever would grow GM storage without
  // bound against the 2000-card cap.
  cs.purgeExpiredTombstones();
  // Tombstones stay OUT of the site mirror: the /data page lists what exists,
  // and the prune below removes any row whose card is now deleted.
  const index = cs._index().filter((e) => !e.del);
  const now = new Date();
  const dueCount = index.filter((e) => new Date(e.due) <= now).length;
  localStorage.setItem(
    "lk:status",
    JSON.stringify({
      version: GM_info?.script?.version ?? "?",
      cardCount: index.length,
      dueCount,
      lastSync: Date.now(),
    }),
  );
  // No early return on an empty index: an empty index is exactly what a "delete
  // all" produces, and that is when the mirror most needs clearing.
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("lianki-keyval", 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore("keyval");
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    // Read the existing keys in their OWN transaction: awaiting anything inside
    // a readwrite transaction risks it auto-committing before the writes land.
    const existingKeys = await new Promise((resolve) => {
      const req = db.transaction("keyval", "readonly").objectStore("keyval").getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });

    const tx = db.transaction("keyval", "readwrite");
    const store = tx.objectStore("keyval");

    // Prune. This sync used to only put(), so a card deleted anywhere stayed in
    // the site's mirror forever and the /data page kept listing it. GM storage
    // is the source of truth here, so anything absent from the index is gone.
    const live = new Set(index.map((e) => "card:" + e.url));
    for (const key of existingKeys) {
      if (typeof key === "string" && key.startsWith("card:") && !live.has(key)) store.delete(key);
    }

    for (const entry of index) {
      const raw = GM_getValue(CARD_PREFIX + entry.hash, "");
      if (!raw) continue;
      const { note, hlc, dirty } = JSON.parse(raw);
      if (!note?.card) continue;
      store.put(
        {
          url: note.url || entry.url,
          title: note.title || note.url || entry.url,
          card: note.card,
          log: note.log || [],
          hlc: hlc || note.hlc,
          synced: !dirty,
        },
        "card:" + (note.url || entry.url),
      );
    }
    store.put(index.length, "meta:gm-count");
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
    db.close();
    console.log(`[Lianki] Synced ${index.length} cards to site IndexedDB`);
  } catch (err) {
    console.error("[Lianki] syncToSiteDB failed:", err);
  }
}

// ============================================================================
// Local FSRS Calculations (using bundled ts-fsrs)
// ============================================================================

class LocalFSRS {
  constructor(params = null) {
    this.Rating = Rating;
    this.params = params || generatorParameters({});
    this.scheduler = fsrs(this.params);
  }

  /**
   * Calculate review options for a card
   * Returns array of 4 options (Again, Hard, Good, Easy)
   */
  calculateOptions(card, now = new Date()) {
    const scheduleInfo = this.scheduler.repeat(card, now);

    return [
      {
        rating: 1,
        label: "Again",
        card: scheduleInfo[this.Rating.Again].card,
        log: scheduleInfo[this.Rating.Again].log,
        due: this.formatDue(scheduleInfo[this.Rating.Again].card.due),
      },
      {
        rating: 2,
        label: "Hard",
        card: scheduleInfo[this.Rating.Hard].card,
        log: scheduleInfo[this.Rating.Hard].log,
        due: this.formatDue(scheduleInfo[this.Rating.Hard].card.due),
      },
      {
        rating: 3,
        label: "Good",
        card: scheduleInfo[this.Rating.Good].card,
        log: scheduleInfo[this.Rating.Good].log,
        due: this.formatDue(scheduleInfo[this.Rating.Good].card.due),
      },
      {
        rating: 4,
        label: "Easy",
        card: scheduleInfo[this.Rating.Easy].card,
        log: scheduleInfo[this.Rating.Easy].log,
        due: this.formatDue(scheduleInfo[this.Rating.Easy].card.due),
      },
    ];
  }

  /**
   * Format due date as relative string
   */
  formatDue(dueDate) {
    const now = new Date();
    const diffMs = new Date(dueDate) - now;
    const diffMins = Math.round(diffMs / 60000);
    const diffHours = Math.round(diffMs / 3600000);
    const diffDays = Math.round(diffMs / 86400000);

    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 30) return `${diffDays}d`;

    const diffMonths = Math.round(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths}mo`;

    const diffYears = Math.round(diffDays / 365);
    return `${diffYears}y`;
  }

  newCard() {
    const now = new Date();
    return {
      due: now,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: 0, // State.New
      last_review: now,
    };
  }

  /**
   * Apply review to card
   */
  applyReview(card, rating, now = new Date()) {
    const scheduleInfo = this.scheduler.repeat(card, now);
    const ratingKey = [
      this.Rating.Manual,
      this.Rating.Again,
      this.Rating.Hard,
      this.Rating.Good,
      this.Rating.Easy,
    ][rating];

    return scheduleInfo[ratingKey];
  }
}

function main() {
  // Set global marker so web UI knows userscript is installed
  window.LIANKI_USERSCRIPT_INSTALLED = true;

  // ── Origin ─────────────────────────────────────────────────────────────────
  // Auto-detected from @downloadURL.
  // Normalize www.lianki.com → bare lianki.com: apex is the canonical host
  // (middleware.ts 308s www → apex), and session cookies bind to the exact
  // hostname the user logged in on. Copies installed before v2.23.18 carry the
  // old www @downloadURL, so this rewrite repairs them without a reinstall.
  const ORIGIN = (() => {
    try {
      const u = new URL(GM_info?.script?.downloadURL || "");
      if (u.hostname === "www.lianki.com") u.hostname = "lianki.com";
      return u.origin;
    } catch {
      return "https://lianki.com";
    }
  })();

  // ── URL normalization ───────────────────────────────────────────────────────
  function normalizeUrl(href) {
    try {
      const u = new URL(href);
      // youtu.be/ID → youtube.com/watch?v=ID
      if (u.hostname === "youtu.be") {
        const id = u.pathname.slice(1);
        u.hostname = "www.youtube.com";
        u.pathname = "/watch";
        u.searchParams.set("v", id);
      }
      // m.example.com → www.example.com
      if (u.hostname.startsWith("m.")) u.hostname = "www." + u.hostname.slice(2);
      // Strip YouTube playlist position (index changes when playlist is reordered)
      if (u.hostname.endsWith("youtube.com") && u.pathname === "/watch")
        u.searchParams.delete("index");
      // Strip tracking, session & display-preference params
      for (const p of [
        "si",
        "pp",
        "feature",
        "ref",
        "source",
        "theme",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
        "mc_cid",
        "mc_eid",
        "igshid",
      ])
        u.searchParams.delete(p);
      u.searchParams.sort();
      return u.toString();
    } catch {
      return href;
    }
  }

  // On the Lianki site itself: sync GM cards to IndexedDB for offline display, then exit.
  // Match www too — it 308s to apex, but a stale tab can still be sitting on it.
  const originHost = new URL(ORIGIN).hostname;
  if (location.hostname === originHost || location.hostname === "www." + originHost) {
    setTimeout(() => syncToSiteDB(), 500);
    return () => {};
  }

  const ac = new AbortController();
  const { signal } = ac;

  // ── Constants ──────────────────────────────────────────────────────────────
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  // User preferences (loaded from API).
  //
  // The shape must match what GET /api/preferences actually returns, which is
  // `{ mobileExcludePatterns }`. This used to declare the long-deprecated
  // `mobileExcludeDomains`, which the API stopped sending — so it read back
  // undefined and every filter the user configured on /preferences was silently
  // dropped before it reached the server.
  let userPreferences = {
    mobileExcludePatterns: [], // default: no filters
  };

  // Load preferences on startup (called after api() is defined)
  async function loadPreferences() {
    try {
      const cached = GM_getValue("lk:preferences", "");
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        // Use cached if less than 1 hour old
        if (Date.now() - ts < 60 * 60 * 1000) {
          userPreferences = data;
          return;
        }
      }

      // Fetch fresh preferences
      const prefs = await api("/api/preferences");
      userPreferences = prefs;
      GM_setValue("lk:preferences", JSON.stringify({ data: prefs, ts: Date.now() }));
    } catch (err) {
      console.log("[Lianki] Failed to load preferences, using defaults:", err);
    }
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    phase: "idle",
    noteId: null,
    options: null,
    error: null,
    message: null,
    notes: "",
    notesSynced: true,
  };
  let fab = null;
  let dialog = null;
  let prefetchedNextUrl = null; // populated while user reads current card
  let prefetchLink = null; // <link rel="prefetch"> element for next page
  let videoObserver = null; // MutationObserver for video presence

  // ── Auto-update ────────────────────────────────────────────────────────────
  const CURRENT_VERSION = GM_info?.script?.version ?? "0.0.0";
  let updatePrompted = false;

  function isNewerVersion(a, b) {
    const seg = (v) => v.split(".").map((n) => parseInt(n) || 0);
    const [aa, ab, ac2] = seg(a);
    const [ba, bb, bc] = seg(b);
    return aa !== ba ? aa > ba : ab !== bb ? ab > bb : ac2 > bc;
  }

  function checkVersion(r) {
    if (updatePrompted) return;
    const sv = r.headers.get("x-lianki-version");
    if (sv && isNewerVersion(sv, CURRENT_VERSION)) {
      updatePrompted = true;
      window.open(`${ORIGIN}/lianki.user.js`, "_blank");
    }
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  // Inline wrapper around GM_xmlhttpRequest — avoids gm-fetch's set-cookie
  // header bug that throws on strict mobile environments.
  function gmFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const token = GM_getValue("lk:token", "");
      const headers = { ...opts.headers };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      GM_xmlhttpRequest({
        method: (opts.method || "GET").toUpperCase(),
        url: String(url),
        headers,
        data: opts.body ?? undefined,
        withCredentials: opts.credentials === "include",
        onload(resp) {
          const hdrs = {};
          for (const line of resp.responseHeaders.split("\r\n")) {
            const i = line.indexOf(": ");
            if (i > 0) {
              const name = line.slice(0, i).toLowerCase();
              if (name !== "set-cookie") hdrs[name] = line.slice(i + 2);
            }
          }
          resolve({
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            headers: { get: (n) => hdrs[n.toLowerCase()] ?? null },
            json() {
              try {
                return Promise.resolve(JSON.parse(resp.responseText));
              } catch {
                const preview = resp.responseText.slice(0, 120).replace(/\s+/g, " ").trim();
                const err = new Error(`Login required (got: ${preview})`);
                err.details = resp.responseText.slice(0, 2000);
                err.statusCode = resp.status;
                return Promise.reject(err);
              }
            },
            text: () => Promise.resolve(resp.responseText),
          });
        },
        onerror() {
          reject(new Error("Network error"));
        },
        onabort() {
          reject(new Error("Request aborted"));
        },
      });
    });
  }

  // ── API ────────────────────────────────────────────────────────────────────
  const api = (path, opts = {}) =>
    gmFetch(`${ORIGIN}${path}`, { credentials: "include", ...opts }).then((r) => {
      if (r.status === 401) {
        const e = new Error("Login required");
        e.status = 401;
        throw e;
      }
      if (!r.ok) {
        const status = r.status;
        return r
          .json()
          .catch(() => null)
          .then((body) => {
            const e = new Error(`HTTP ${status}`);
            // Callers need the status and body to tell a permanent failure from
            // a transient one. Without these only 401 carried a status, so the
            // sync queue could not distinguish "will never succeed" from "try
            // again later" and retried both — see tryBackgroundSync.
            e.status = status;
            e.body = body;
            if (body?.errorId) e.details = `Error ID: ${body.errorId}`;
            else if (body?.error) e.details = body.error;
            throw e;
          });
      }
      checkVersion(r);
      return r.json();
    });

  // ── Cache (keyv-style, GM_setValue as cross-origin storage adapter) ────────
  function gmCache(key, ttlMs, fn) {
    try {
      const raw = GM_getValue(key);
      if (raw) {
        const { v, exp } = JSON.parse(raw);
        if (Date.now() < exp) return Promise.resolve(v);
      }
    } catch {}
    return fn().then((v) => {
      GM_setValue(key, JSON.stringify({ v, exp: Date.now() + ttlMs }));
      return v;
    });
  }

  function gmCacheInvalidate(key) {
    GM_setValue(key, "");
  }

  // ── API helpers ────────────────────────────────────────────────────────────
  const noteKey = (url) => `lk:note:${url}`;

  // Cache addNote by normalized URL for 10 min — skips round-trip on repeat visits
  const addNote = (url, title) =>
    gmCache(noteKey(url), 10 * 60 * 1000, () =>
      api("/api/fsrs/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, title }),
      }),
    );

  // Build the excludeDomains query param used to filter the next card.
  //
  // The server matches these as plain substrings of the card URL, so `domain`
  // and `url` patterns both map onto it. `title` patterns and `isRegex` cannot
  // be expressed in this wire format — the server escapes what it receives —
  // so they are skipped here rather than sent and silently mismatched. See the
  // Backlog entry in TODO.md for carrying the full pattern set.
  const buildExcludeDomainsParam = () => {
    if (!isMobile) return "";
    const patterns = userPreferences.mobileExcludePatterns || [];
    const values = patterns
      .filter((p) => p && p.enabled !== false && !p.isRegex)
      .filter((p) => p.type === "domain" || p.type === "url")
      .map((p) => String(p.pattern || "").trim())
      // A comma would split into two bogus entries on the server side.
      .filter((p) => p && !p.includes(","));
    if (values.length === 0) return "";
    return `&excludeDomains=${values.map(encodeURIComponent).join(",")}`;
  };

  const saveNotes = (id, notes) =>
    api(`/api/fsrs/notes?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    });
  const getOptions = (id) => api(`/api/fsrs/options?id=${encodeURIComponent(id)}`);
  const submitReview = (id, rating) =>
    api(`/api/fsrs/review/${rating}/?id=${encodeURIComponent(id)}${buildExcludeDomainsParam()}`);
  const deleteNote = (id) =>
    api(`/api/fsrs/delete?id=${encodeURIComponent(id)}${buildExcludeDomainsParam()}`);
  const getNextUrl = () => {
    const excludeUrl = `&excludeUrl=${encodeURIComponent(normalizeUrl(location.href))}`;
    return api(`/api/fsrs/next-url?${buildExcludeDomainsParam().slice(1)}${excludeUrl}`);
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const btn = (bg, extra = "") =>
    `all:initial;display:inline-block;box-sizing:border-box;background:${bg};color:${bg === "transparent" ? "var(--lk-fg)" : "#eee"};border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;min-width:60px;line-height:1.5;text-align:center;${extra}`;

  // Prefetch next page for faster navigation
  function prefetchNextPage(pageUrl) {
    if (!pageUrl) return;

    // Remove old prefetch link if exists
    if (prefetchLink) {
      prefetchLink.remove();
      prefetchLink = null;
    }

    // Create and append new prefetch link
    prefetchLink = document.createElement("link");
    prefetchLink.rel = "prefetch";
    prefetchLink.href = pageUrl;
    prefetchLink.as = "document";
    document.head.appendChild(prefetchLink);
    console.log("[Lianki] Prefetching next page:", pageUrl);
  }

  // ── UI: combined FAB + speed controls ─────────────────────────────────────
  function createUI() {
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "fixed",
      zIndex: "2147483647",
      display: "flex",
      gap: "0",
      alignItems: "center",
      userSelect: "none",
      touchAction: "none",
      background: "rgba(20,20,20,0.82)",
      borderRadius: "999px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)",
      overflow: "hidden",
    });

    let isDragged = false;
    const BTN_BASE =
      "border:none;cursor:pointer;background:transparent;color:#eee;" +
      "padding:10px 14px;font-size:15px;font-weight:bold;touch-action:manipulation;" +
      "transition:background 0.2s;";
    const BTN_HOVER = "background:rgba(255,255,255,0.1);";
    const makeBtn = (text, title, action) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.style.cssText = BTN_BASE;
      b.addEventListener("mouseenter", () => {
        if (!isDragged) b.style.background = "rgba(255,255,255,0.1)";
      });
      b.addEventListener("mouseleave", () => {
        b.style.background = "transparent";
      });
      b.addEventListener("click", (e) => {
        if (isDragged) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        action();
      });
      return b;
    };

    const slowerBtn = makeBtn("⏪", "Slower (,/v)", () => pardon(-3, 0.7));
    const liankiBtn = makeBtn("🔖", "Lianki (Alt+F)", () =>
      dialog ? closeDialog() : openDialog(),
    );
    const fasterBtn = makeBtn("⏩", "Faster (./b)", () => pardon(0, 1.2));

    // Add separators between buttons
    const makeSeparator = () => {
      const sep = document.createElement("div");
      sep.style.cssText =
        "width:1px;height:24px;background:rgba(255,255,255,0.15);align-self:center;";
      return sep;
    };

    container.append(slowerBtn, makeSeparator(), liankiBtn, makeSeparator(), fasterBtn);

    // Hide/show video control buttons based on video presence
    const updateVideoButtonVisibility = () => {
      const hasVideo = document.querySelector("video,audio") !== null;
      const display = hasVideo ? "" : "none";
      slowerBtn.style.display = display;
      fasterBtn.style.display = display;
      // Also hide separators when video buttons are hidden
      const separators = container.querySelectorAll("div");
      if (hasVideo) {
        separators[0].style.display = "";
        separators[1].style.display = "";
      } else {
        separators[0].style.display = "none";
        separators[1].style.display = "none";
      }
    };

    // Update border radius based on edge proximity
    const EDGE_THRESHOLD = 5; // pixels from edge to remove radius
    const updateBorderRadius = () => {
      const r = container.getBoundingClientRect();
      const atLeft = r.left <= EDGE_THRESHOLD;
      const atRight = r.right >= window.innerWidth - EDGE_THRESHOLD;
      const atTop = r.top <= EDGE_THRESHOLD;
      const atBottom = r.bottom >= window.innerHeight - EDGE_THRESHOLD;

      let radius = "999px";
      if (atLeft && atTop)
        radius = "0 999px 999px 0"; // top-left corner
      else if (atRight && atTop)
        radius = "999px 0 0 999px"; // top-right corner
      else if (atLeft && atBottom)
        radius = "0 999px 999px 0"; // bottom-left corner
      else if (atRight && atBottom)
        radius = "999px 0 0 999px"; // bottom-right corner
      else if (atLeft)
        radius = "0 999px 999px 0"; // left edge
      else if (atRight)
        radius = "999px 0 0 999px"; // right edge
      else if (atTop)
        radius = "0 0 999px 999px"; // top edge
      else if (atBottom) radius = "999px 999px 0 0"; // bottom edge

      container.style.borderRadius = radius;
    };

    // Constrain position within screen bounds
    const constrainPosition = () => {
      const r = container.getBoundingClientRect();
      const currentLeft = parseInt(container.style.left) || r.left;
      const currentTop = parseInt(container.style.top) || r.top;
      const newLeft = Math.max(0, Math.min(window.innerWidth - r.width, currentLeft));
      const newTop = Math.max(0, Math.min(window.innerHeight - r.height, currentTop));

      if (newLeft !== currentLeft || newTop !== currentTop) {
        container.style.right = "auto";
        container.style.bottom = "auto";
        container.style.left = newLeft + "px";
        container.style.top = newTop + "px";
      }
      updateBorderRadius();
    };

    // Initial check
    updateVideoButtonVisibility();

    // Watch for video elements being added/removed
    videoObserver = new MutationObserver(updateVideoButtonVisibility);
    videoObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Handle window resize
    window.addEventListener("resize", constrainPosition, { signal });

    let dragging = false;
    let startX = 0,
      startY = 0,
      startLeft = 0,
      startTop = 0;

    const initDrag = (clientX, clientY) => {
      isDragged = false;
      dragging = true;
      const r = container.getBoundingClientRect();
      startX = clientX;
      startY = clientY;
      startLeft = r.left;
      startTop = r.top;
      container.style.right = "auto";
      container.style.bottom = "auto";
      container.style.left = startLeft + "px";
      container.style.top = startTop + "px";
    };
    const moveDrag = (clientX, clientY) => {
      if (!dragging) return;
      const dx = clientX - startX,
        dy = clientY - startY;
      if (!isDragged && Math.abs(dx) + Math.abs(dy) > 6) {
        isDragged = true;
        const r = container.getBoundingClientRect();
        startLeft = clientX - r.width / 2;
        startTop = clientY - r.height / 2;
        startX = clientX;
        startY = clientY;
      }
      if (isDragged) {
        const r = container.getBoundingClientRect();
        const newLeft = startLeft + (clientX - startX);
        const newTop = startTop + (clientY - startY);
        container.style.left = Math.max(0, Math.min(window.innerWidth - r.width, newLeft)) + "px";
        container.style.top = Math.max(0, Math.min(window.innerHeight - r.height, newTop)) + "px";
        updateBorderRadius();
      }
    };
    const stopDrag = () => {
      if (isDragged) {
        GM_setValue(
          "lianki_pos",
          JSON.stringify({ x: parseInt(container.style.left), y: parseInt(container.style.top) }),
        );
        updateBorderRadius();
      }
      dragging = false;
    };

    container.addEventListener(
      "touchstart",
      (e) => initDrag(e.touches[0].clientX, e.touches[0].clientY),
      { passive: true },
    );
    container.addEventListener(
      "touchmove",
      (e) => {
        if (dragging) {
          e.preventDefault();
          moveDrag(e.touches[0].clientX, e.touches[0].clientY);
        }
      },
      { passive: false },
    );
    container.addEventListener("touchend", stopDrag, { passive: true });
    container.addEventListener("mousedown", (e) => {
      initDrag(e.clientX, e.clientY);
      const onMove = (ev) => moveDrag(ev.clientX, ev.clientY);
      const onUp = () => {
        stopDrag();
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    document.body.appendChild(container);
    // Load saved position after mount so getBoundingClientRect gives real width
    try {
      const saved = JSON.parse(GM_getValue("lianki_pos", "null"));
      if (saved) {
        const r = container.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - r.width, saved.x));
        const y = Math.max(0, Math.min(window.innerHeight - r.height, saved.y));
        container.style.right = "auto";
        container.style.bottom = "auto";
        container.style.left = x + "px";
        container.style.top = y + "px";
      } else {
        container.style.right = "12px";
        container.style.bottom = "20px";
      }
    } catch {
      container.style.right = "12px";
      container.style.bottom = "20px";
    }

    // Set initial border radius based on position
    updateBorderRadius();

    return container;
  }

  // ── Dialog ─────────────────────────────────────────────────────────────────
  function mountDialog() {
    // Create shadow host for complete CSS isolation
    const shadowHost = document.createElement("div");
    shadowHost.style.cssText = "all: initial; position: fixed; z-index: 2147483647;";

    const shadow = shadowHost.attachShadow({ mode: "open" });

    // Add base reset styles in shadow DOM
    const styleReset = document.createElement("style");
    styleReset.textContent = `
      * { all: initial; box-sizing: border-box; }
      *:before, *:after { all: initial; box-sizing: border-box; }
      style { display: none !important; }
      :host {
        --lk-bg: #1e1e1e;
        --lk-fg: #eeeeee;
        --lk-shadow: 0 8px 32px rgba(0,0,0,0.6);
        --lk-input-bg: #222222;
        --lk-input-fg: #dddddd;
        --lk-input-border: #444444;
        --lk-muted: #aaaaaa;
        --lk-backdrop: rgba(0,0,0,0.75);
        --lk-error: #ff8a80;
        --lk-success: #69f0ae;
      }
      @media (prefers-color-scheme: light) {
        :host {
          --lk-bg: #ffffff;
          --lk-fg: #111111;
          --lk-shadow: 0 8px 32px rgba(0,0,0,0.15);
          --lk-input-bg: #f0f0f0;
          --lk-input-fg: #333333;
          --lk-input-border: #cccccc;
          --lk-muted: #666666;
          --lk-backdrop: rgba(0,0,0,0.5);
          --lk-error: #b71c1c;
          --lk-success: #1b5e20;
        }
      }
    `;
    shadow.appendChild(styleReset);

    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, {
      all: "initial",
      position: "fixed",
      inset: "0",
      background: "var(--lk-backdrop)",
      zIndex: "2147483645",
    });
    backdrop.addEventListener("click", closeDialog);

    const el = document.createElement("div");
    el.tabIndex = -1;
    Object.assign(el.style, {
      all: "initial",
      position: "fixed",
      zIndex: "2147483646",
      top: "50%",
      left: "50%",
      transform: "translate(-50%,-50%)",
      background: "var(--lk-bg)",
      color: "var(--lk-fg)",
      borderRadius: "12px",
      padding: "20px 24px",
      minWidth: "320px",
      maxWidth: "min(480px, 90vw)",
      maxHeight: "90vh",
      overflowY: "auto",
      boxShadow: "var(--lk-shadow)",
      fontFamily: "system-ui,sans-serif",
      fontSize: "14px",
      outline: "none",
      lineHeight: "1.5",
      boxSizing: "border-box",
    });

    shadow.appendChild(backdrop);
    shadow.appendChild(el);
    document.body.appendChild(shadowHost);

    el._backdrop = backdrop;
    el._shadowHost = shadowHost;
    return el;
  }

  function renderDialog() {
    if (!dialog) return;
    const { phase, options, error, message } = state;

    while (dialog.lastChild) dialog.removeChild(dialog.lastChild);

    // Add global style reset for all child elements
    const globalStyle = document.createElement("style");
    globalStyle.textContent = `
      * { font-family: system-ui, sans-serif; box-sizing: border-box; }
      div, span, button, a { all: revert; }
      button { cursor: pointer; }
    `;
    dialog.appendChild(globalStyle);

    // Header
    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "16px",
    });
    const titleSpan = document.createElement("span");
    Object.assign(titleSpan.style, { fontWeight: "700", fontSize: "16px" });
    titleSpan.textContent = "🔖 Lianki";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.setAttribute(
      "style",
      `${btn("transparent")};color:var(--lk-muted);font-size:20px;padding:0 6px;line-height:1`,
    );
    closeBtn.addEventListener("click", closeDialog);
    header.appendChild(titleSpan);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    // Body
    if (phase === "adding") {
      const styleEl = document.createElement("style");
      styleEl.textContent =
        "@keyframes lk-spin{to{transform:rotate(360deg)}}" +
        ".lk-spinner{display:inline-block;width:20px;height:20px;" +
        "border:3px solid #555;border-top-color:#7eb8f7;border-radius:50%;" +
        "animation:lk-spin 0.8s linear infinite;vertical-align:middle;margin-right:8px}";
      dialog.appendChild(styleEl);

      const wrap = document.createElement("div");
      Object.assign(wrap.style, { display: "flex", flexDirection: "column", gap: "10px" });
      const spinRow = document.createElement("div");
      Object.assign(spinRow.style, { fontSize: "15px", fontWeight: "600" });
      const spinner = document.createElement("span");
      spinner.className = "lk-spinner";
      spinRow.appendChild(spinner);
      spinRow.appendChild(document.createTextNode("Adding note\u2026"));
      const urlDiv = document.createElement("div");
      Object.assign(urlDiv.style, {
        color: "var(--lk-muted)",
        fontSize: "12px",
        wordBreak: "break-all",
      });
      urlDiv.textContent = normalizeUrl(location.href);
      wrap.appendChild(spinRow);
      wrap.appendChild(urlDiv);
      dialog.appendChild(wrap);
    } else if (phase === "error") {
      const errDiv = document.createElement("div");
      errDiv.style.color = "var(--lk-error)";
      errDiv.textContent = `Error: ${error}`;
      dialog.appendChild(errDiv);
      if (state.errorDetails) {
        const detailDiv = document.createElement("div");
        Object.assign(detailDiv.style, {
          fontSize: "11px",
          color: "var(--lk-muted)",
          marginTop: "4px",
          wordBreak: "break-all",
        });
        detailDiv.textContent = state.errorDetails;
        dialog.appendChild(detailDiv);
      }

      const btnRow = document.createElement("div");
      Object.assign(btnRow.style, {
        display: "flex",
        gap: "8px",
        marginTop: "10px",
        flexWrap: "wrap",
      });

      const loginBtn = document.createElement("button");
      loginBtn.setAttribute("style", btn("#2a5f8f"));
      loginBtn.textContent = "Login to Lianki";
      loginBtn.addEventListener("click", () => window.open(ORIGIN, "_blank"));
      btnRow.appendChild(loginBtn);

      const copyBtn = document.createElement("button");
      copyBtn.setAttribute("style", btn("#444"));
      copyBtn.textContent = "Copy error";
      copyBtn.addEventListener("click", () => {
        const parts = [
          `Error: ${error}`,
          `Page: ${location.href}`,
          `Origin: ${ORIGIN}`,
          `Version: ${CURRENT_VERSION}`,
        ];
        if (state.errorDetails) parts.push(`\nResponse:\n${state.errorDetails}`);
        const text = parts.join("\n");
        navigator.clipboard?.writeText(text).catch(() => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;opacity:0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        });
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy error";
        }, 2000);
      });
      btnRow.appendChild(copyBtn);
      dialog.appendChild(btnRow);
    } else if (phase === "reviewing") {
      const titleDiv = document.createElement("div");
      Object.assign(titleDiv.style, {
        marginBottom: "12px",
        wordBreak: "break-all",
        fontSize: "13px",
        opacity: ".8",
      });
      const bold = document.createElement("b");
      bold.textContent = document.title || location.href;
      titleDiv.appendChild(bold);
      dialog.appendChild(titleDiv);

      const btnRow = document.createElement("div");
      Object.assign(btnRow.style, {
        display: "flex",
        gap: "8px",
        flexWrap: "wrap",
        marginBottom: "8px",
      });
      for (const o of options) {
        const b = document.createElement("button");
        b.setAttribute("style", btn("#2a5f8f"));
        b.appendChild(document.createTextNode(o.label));
        b.appendChild(document.createElement("br"));
        const small = document.createElement("small");
        Object.assign(small.style, { color: "rgba(255,255,255,0.9)", fontSize: "11px" });
        small.textContent = o.due;
        b.appendChild(small);
        b.addEventListener("click", () => doReview(Number(o.rating)));
        btnRow.appendChild(b);
      }
      dialog.appendChild(btnRow);

      const deleteBtn = document.createElement("button");
      deleteBtn.setAttribute("style", btn("#7a2a2a"));
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", doDelete);
      dialog.appendChild(deleteBtn);

      const hints = document.createElement("div");
      Object.assign(hints.style, { marginTop: "14px", opacity: ".6", fontSize: "11px" });
      hints.textContent =
        "A/H=Easy \u00b7 S/J=Good \u00b7 W/K=Hard \u00b7 D/L=Again \u00b7 T/M=Delete \u00b7 Esc=Close";
      dialog.appendChild(hints);

      // Notes input
      const notesRow = document.createElement("div");
      Object.assign(notesRow.style, { marginTop: "10px", position: "relative" });

      const notesInput = document.createElement("input");
      notesInput.type = "text";
      notesInput.maxLength = 128;
      notesInput.placeholder = "Notes\u2026";
      notesInput.value = state.notes;
      notesInput.tabIndex = -1; // Don't auto-focus (preserve hotkeys)
      Object.assign(notesInput.style, {
        width: "100%",
        boxSizing: "border-box",
        background: "var(--lk-input-bg)",
        color: "var(--lk-input-fg)",
        border: "1px solid var(--lk-input-border)",
        borderRadius: "6px",
        padding: "6px 28px 6px 8px",
        fontSize: "12px",
        outline: "none",
      });

      const syncIndicator = document.createElement("span");
      Object.assign(syncIndicator.style, {
        position: "absolute",
        right: "8px",
        top: "50%",
        transform: "translateY(-50%)",
        fontSize: "13px",
        opacity: ".7",
        pointerEvents: "none",
      });
      syncIndicator.textContent = state.notesSynced ? "\u2713" : "\u22ef";

      let notesTimer = null;
      notesInput.addEventListener("input", () => {
        const val = notesInput.value.slice(0, 128);
        state.notes = val;
        state.notesSynced = false;
        syncIndicator.textContent = "\u22ef"; // ellipsis = pending
        clearTimeout(notesTimer);
        notesTimer = setTimeout(async () => {
          try {
            await saveNotes(state.noteId, val);
            state.notesSynced = true;
            syncIndicator.textContent = "\u2713"; // checkmark = synced
          } catch {
            syncIndicator.textContent = "\u2717"; // cross = error
          }
        }, 1000);
      });

      notesRow.appendChild(notesInput);
      notesRow.appendChild(syncIndicator);
      dialog.appendChild(notesRow);
    } else if (phase === "reviewed") {
      const msgDiv = document.createElement("div");
      Object.assign(msgDiv.style, { color: "var(--lk-success)", fontSize: "15px" });
      msgDiv.textContent = message;
      dialog.appendChild(msgDiv);
    }

    // Sync status indicator (offline mode)
    if (offlineReady) {
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
      const queue = queueStorage.getQueue();
      if (!navigator.onLine) indicator.textContent = "📴 Offline";
      else if (syncInProgress) indicator.textContent = "🔄 Syncing...";
      else if (queue.length > 0) indicator.textContent = `⏳ ${queue.length}`;
      else indicator.textContent = "✓";
      dialog.appendChild(indicator);
    }
  }

  // ── Open / Close ───────────────────────────────────────────────────────────
  function openDialog() {
    if (dialog) return;
    dialog = mountDialog();
    state = { phase: "adding", noteId: null, options: null, error: null, message: null };
    prefetchedNextUrl = null;
    renderDialog();
    dialog.focus();

    const url = normalizeUrl(location.href);
    addNote(url, document.title)
      .then((note) => {
        state.noteId = note._id;
        state.notes = note.notes ?? "";
        state.notesSynced = true;
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
  }

  function closeDialog() {
    if (!dialog) return;
    dialog._backdrop?.remove();
    dialog._shadowHost?.remove();
    dialog.remove();
    dialog = null;
    state = { phase: "idle", noteId: null, options: null, error: null, message: null };

    // Clean up prefetch link when closing dialog
    if (prefetchLink) {
      prefetchLink.remove();
      prefetchLink = null;
    }
  }

  // ── Review actions ─────────────────────────────────────────────────────────
  async function doReview(rating) {
    if (state.phase !== "reviewing" || !state.noteId) return;
    try {
      const result = await submitReview(state.noteId, rating);
      // Always update from server (even null) to prevent stale value re-navigating to current card
      prefetchedNextUrl = result.nextUrl ?? null;
      if (result.nextUrl) prefetchNextPage(result.nextUrl);
      const opt = state.options.find((o) => Number(o.rating) === rating);
      await afterReview(`Reviewed! Next due: ${opt?.due ?? "?"}`);
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      state.errorDetails = err.details ?? null;
      renderDialog();
    }
  }

  async function doDelete() {
    if (state.phase !== "reviewing" || !state.noteId) return;
    const url = normalizeUrl(location.href);
    try {
      // Delete from local cache first
      if (offlineReady) {
        try {
          cardStorage.deleteCard(url);
        } catch (e) {
          console.error("[Lianki] Local delete failed:", e);
        }
      }
      gmCacheInvalidate(noteKey(url));

      // Find next card from local cache before server call
      if (offlineReady) {
        try {
          const dueCards = cardStorage.getDueCards(2);
          const nextCard = dueCards.find((c) => c.url !== url);
          prefetchedNextUrl = nextCard?.url ?? null;
          if (prefetchedNextUrl) prefetchNextPage(prefetchedNextUrl);
        } catch (e) {
          prefetchedNextUrl = null;
        }
      }

      // Try server delete (may fail for local-only cards — that's OK)
      if (!state.noteId.startsWith("local:")) {
        try {
          const result = await deleteNote(state.noteId);
          // Server response overrides local prefetch if available
          if (result.nextUrl) {
            prefetchedNextUrl = result.nextUrl;
            prefetchNextPage(result.nextUrl);
          }
        } catch (err) {
          console.error("[Lianki] Server delete failed:", err);
          // Continue — local delete already succeeded
        }
      } else if (offlineReady) {
        // Queue delete for background sync
        queueStorage.addToQueue("delete", { url, noteId: state.noteId }, newHLC(deviceId));
      }

      await afterReview("Deleted!");
    } catch (err) {
      state.phase = "error";
      state.error = err.message;
      state.errorDetails = err.details ?? null;
      renderDialog();
    }
  }

  /**
   * Is this card's page actually reachable?
   *
   * A page whose host refuses connections cannot be reviewed away, because no
   * content script runs on the browser's network-error page — there is nothing
   * for the userscript to attach to. The card therefore stays due forever and
   * is served again and again. The only escape was the dashboard. Observed with
   * a retired site that still had 75 cards in the deck, 18 of them due.
   *
   * So the check has to happen HERE, on a page that is still alive, before
   * navigating away.
   *
   * Deliberately conservative: only a connection-level failure counts as dead.
   * HTTP status is not evidence — plenty of perfectly good pages answer 403 to
   * a HEAD from a script, sit behind bot walls, or return 404 while rendering
   * content. Skipping those would be worse than the problem being solved.
   */
  function rawProbe(url, timeoutMs = 6000) {
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: "HEAD",
          url,
          timeout: timeoutMs,
          // No cookies. GM_xmlhttpRequest sends them by default, which would
          // mean firing an authenticated request at every third-party site
          // before you visit it — and some endpoints act on a bare GET/HEAD
          // (analytics, "mark as read", rate limits). Whether a host answers at
          // all does not need the user's session, so it does not get it.
          // Managers that predate `anonymous` ignore it and fall back to
          // sending cookies, which is no worse than the previous behaviour.
          anonymous: true,
          // `finalUrl` is the url after redirects, so the probe sees a redirect
          // before we navigate. It is a HINT, not the truth: this request does
          // not carry the browser's full context, and plenty of redirects are
          // decided by Accept-Language or cookies — snomiao.com/ sends a browser
          // to /ja and a bare script to /en. So it is logged, and the
          // authoritative check stays checkRedirect() after landing, which sees
          // where the browser actually ended up.
          onload: (r) => resolve({ ok: true, finalUrl: r?.finalUrl || url, status: r?.status }),
          onerror: (e) => resolve({ ok: false, blocked: isConnectRefusal(e) }),
          ontimeout: () => resolve({ ok: false }),
        });
      } catch {
        resolve({ ok: true }); // never block navigation because the probe broke
      }
    });
  }

  /**
   * Did the userscript manager refuse this request outright?
   *
   * A refusal is not a network failure, but `onerror` reports both. Violentmonkey
   * says `Refused to connect to "...": This domain is not a part of the @connect
   * list`; other managers word it differently, so match loosely and treat a
   * miss as inconclusive rather than trusting the wording.
   */
  function isConnectRefusal(e) {
    const msg = String(e?.error ?? e?.message ?? e?.statusText ?? "").toLowerCase();
    return msg.includes("@connect") || msg.includes("refused to connect");
  }

  /**
   * Can this manager reach an arbitrary third-party host at all?
   *
   * A failed probe has two causes that `onerror` cannot tell apart: the site is
   * down, or the manager refused the request. When the script shipped
   * `@connect lianki.com` only, EVERY probe was refused — so a live YouTube page
   * was reported unreachable and skipped.
   *
   * The control CANNOT be the current page. Managers always allow requests to
   * the origin the script is running on, so that probe succeeds even while every
   * other host is refused — measured directly: youtube.com came back
   * `Refused to connect` in 3ms while news.ycombinator.com answered 405 from the
   * same page. A control that cannot fail proves nothing.
   *
   * So the control is a third-party host neither we nor the deck chose:
   * Google's `generate_204`, an empty response built for exactly this question.
   * If it cannot be reached — refused, blocked, or simply unavailable where the
   * user is — probes are not trustworthy here and no card is judged by them.
   */
  let probesUsable = null;
  async function probesAreUsable() {
    if (probesUsable !== null) return probesUsable;
    const r = await rawProbe("https://www.google.com/generate_204", 6000);
    probesUsable = r.ok;
    if (!probesUsable) {
      console.warn(
        "[Lianki] Reachability probes are unusable here (the control host failed too) —" +
          " not skipping any cards. Grant the script cross-origin access to re-enable them.",
      );
    }
    return probesUsable;
  }

  /**
   * `{ok: true}` unless the url is genuinely unreachable AND we can show the
   * probe itself works. Anything less certain resolves ok, because a wrong
   * "dead" verdict silently drops a card the user wanted.
   */
  async function probeUrl(url, timeoutMs = 6000) {
    const r = await rawProbe(url, timeoutMs);
    if (r.ok) return r;
    if (r.blocked) return { ok: true, blocked: true }; // refused, not dead
    return (await probesAreUsable()) ? r : { ok: true, blocked: true };
  }

  /** Remember that a url did not answer, so /data can surface it later. */
  function markUnreachable(url) {
    try {
      const rec = cardStorage?.getCard?.(url);
      if (!rec?.note) return;
      const note = { ...rec.note, unreachableAt: Date.now() };
      cardStorage.setCard(url, note, rec.hlc, rec.dirty ?? false);
    } catch {}
  }

  async function afterReview(doneMessage) {
    state.phase = "reviewed";

    // Use prefetched URL if already ready — redirect is instant, no spinner
    let nextUrl = prefetchedNextUrl;
    let nextTitle = null;
    prefetchedNextUrl = null;

    if (!nextUrl) {
      state.message = "Loading next card\u2026";
      renderDialog();
      const data = await getNextUrl().catch(() => ({ url: null, title: null }));
      nextUrl = data.url;
      nextTitle = data.title;
      if (nextUrl) {
        prefetchNextPage(nextUrl);
        state.message = `Redirecting to:\n${nextTitle || nextUrl}`;
        renderDialog();
      }
    }

    if (nextUrl && /^https?:\/\//.test(nextUrl)) {
      // Do not send the user to a page that cannot answer — they would land on
      // a browser error page where no userscript runs, with no way to review or
      // delete the card that sent them there.
      const probe = await probeUrl(nextUrl);
      if (probe.ok && probe.finalUrl && probe.finalUrl !== nextUrl) {
        console.log("[Lianki] Next card likely redirects:", nextUrl, "->", probe.finalUrl);
      }
      if (!probe.ok) {
        console.warn("[Lianki] Next card is unreachable, skipping:", nextUrl);
        markUnreachable(nextUrl);
        state.message = `Skipped an unreachable page:\n${nextUrl}`;
        renderDialog();
        prefetchedNextUrl = null;
        const again = await getNextUrl().catch(() => ({ url: null }));
        if (again.url && again.url !== nextUrl) {
          GM_setValue("lk:nav_intended", JSON.stringify({ url: again.url, ts: Date.now() }));
          location.href = again.url;
          return;
        }
        state.message = "Skipped an unreachable page — nothing else is due.";
        renderDialog();
        setTimeout(closeDialog, 3000);
        return;
      }

      // Normal navigation to next card (backend already filtered hijacking domains)
      console.log("[Lianki] Storing intended URL:", nextUrl);
      GM_setValue("lk:nav_intended", JSON.stringify({ url: nextUrl, ts: Date.now() }));
      location.href = nextUrl;
    } else {
      // No more cards or invalid URL
      state.message = `${doneMessage} — All done!`;
      renderDialog();
      setTimeout(closeDialog, 2000);
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  const KEYS = {
    Digit1: () => doReview(1),
    KeyD: () => doReview(1),
    KeyL: () => doReview(1),
    Digit2: () => doReview(2),
    KeyW: () => doReview(2),
    KeyK: () => doReview(2),
    Digit3: () => doReview(3),
    KeyS: () => doReview(3),
    KeyJ: () => doReview(3),
    Digit4: () => doReview(4),
    KeyA: () => doReview(4),
    KeyH: () => doReview(4),
    Digit5: () => doDelete(),
    KeyT: () => doDelete(),
    KeyM: () => doDelete(),
    Escape: () => closeDialog(),
  };

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (dialog) closeDialog();
        else openDialog();
        return;
      }
      if (!dialog || state.phase !== "reviewing") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const action = KEYS[e.code];
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        action();
      }
    },
    { capture: true, signal },
  );

  // ── Media Keys ─────────────────────────────────────────────────────────────
  // Support hardware media keys (headphones, keyboards, etc.)
  // nexttrack = faster (1.2x), previoustrack = slower + rewind (-3s, 0.7x)
  (() => {
    let vcid = null;
    document.addEventListener("visibilitychange", trackHandler, { signal });
    function trackHandler() {
      const cb = () => {
        if (!navigator.mediaSession) return;
        navigator.mediaSession.setActionHandler("nexttrack", () => {
          pardon(0, 1.2); // Faster
        });
        navigator.mediaSession.setActionHandler("previoustrack", () => {
          pardon(-1.5, 0.9); // Rewind 1.5s and slightly slower
        });
      };
      if (document.visibilityState === "hidden") {
        vcid = void clearInterval(vcid);
      } else {
        cb();
        vcid ??= setInterval(cb, 1000);
      }
    }
    trackHandler();
  })();

  // ── Mount ──────────────────────────────────────────────────────────────────
  // Load preferences (async, non-blocking)
  loadPreferences();

  fab = createUI();

  // ── Redirect detection ─────────────────────────────────────────────────────
  // If Lianki navigated to a URL but the site auto-redirected to a different
  // one, update the card's stored URL to match the actual final location, then
  // auto-open the review dialog so the session continues uninterrupted.
  // Also handles pushState/replaceState URL changes.

  /**
   * Move a locally cached card from one url to another, following a redirect
   * the server has already recorded.
   *
   * The old key becomes a tombstone rather than simply vanishing, so a stale
   * copy arriving from elsewhere cannot resurrect it (see
   * docs/sync-merge-rules.md). If the destination already holds a card, the
   * newer HLC wins — the redirect may have been noticed after the new url was
   * already being reviewed, which is exactly how the duplicate pair arises.
   */
  function renameLocalCard(oldUrl, newUrl) {
    if (!oldUrl || !newUrl || oldUrl === newUrl) return;
    try {
      // checkRedirect runs on page load, before initOfflineStorage() assigns
      // cardStorage. GMCardStorage keeps no state of its own — it reads and
      // writes GM storage directly — so one can be made on demand rather than
      // skipping the rename on the very page load that detected the redirect.
      const cs = cardStorage ?? new GMCardStorage();
      const from = cs.getCard(oldUrl);
      if (!from) return;
      const to = cs.getCard(newUrl);
      const keepExisting = to && compareHLC(to.hlc, from.hlc) >= 0;
      if (!keepExisting) {
        const note = { ...from.note, url: newUrl };
        cardStorage.setCard(newUrl, note, from.hlc, from.dirty ?? false);
      }
      cardStorage.deleteCard(oldUrl);
      console.log(`[Lianki] Local card moved: ${oldUrl} -> ${newUrl}`);
    } catch (err) {
      console.error("[Lianki] Failed to move local card:", oldUrl, err);
    }
  }

  async function checkRedirect() {
    try {
      const raw = GM_getValue("lk:nav_intended", "");
      if (!raw) return;
      const { url: intendedUrl, ts } = JSON.parse(raw);
      if (Date.now() - ts > 30_000) return; // 30 s TTL — stale, ignore
      const actualUrl = location.href;
      if (normalizeUrl(actualUrl) === normalizeUrl(intendedUrl)) {
        GM_setValue("lk:nav_intended", ""); // no redirect, clear it
        return;
      }

      console.log("[Lianki] Redirect detected:", intendedUrl, "→", actualUrl);

      // Ask user if they want to update the card URL
      const confirmed = confirm(
        `This page redirected from:\n${intendedUrl}\n\n` +
          `To:\n${actualUrl}\n\n` +
          `Update the card to point to the new URL?`,
      );

      if (!confirmed) {
        console.log("[Lianki] User declined URL update");
        GM_setValue("lk:nav_intended", ""); // user declined, clear it
        return;
      }

      const result = await api("/api/fsrs/update-url", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oldUrl: intendedUrl, newUrl: actualUrl }),
      });
      console.log("[Lianki] Card URL updated:", result);
      // Rename the LOCAL copy too, not just the server's.
      //
      // This used to update only the server, leaving GM storage holding the old
      // url with its whole review history and its old due date. That card then
      // came due forever and could not be got rid of: the site had renamed its
      // copy, so nothing there matched the url the userscript kept serving, and
      // deleting the new url did nothing to the old one. Observed in the wild as
      // a card that "reappears again and again" — snomiao.com/ redirecting to
      // snomiao.com/ja left a local snomiao.com/ card six months overdue.
      renameLocalCard(intendedUrl, actualUrl);
      GM_setValue("lk:nav_intended", ""); // only clear after success
      openDialog();
    } catch (err) {
      console.error("[Lianki] Failed to update card URL:", err);
      // Don't clear GM_setValue - retry on next page load
    }
  }

  // Check on page load
  checkRedirect();

  // Monitor URL changes for SPA redirects
  if ("navigation" in window) {
    // Modern Navigation API (Chrome 102+, Edge 102+)
    navigation.addEventListener("navigatesuccess", () => checkRedirect(), { signal });
  } else {
    // Fallback: wrap history methods for older browsers
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      setTimeout(checkRedirect, 100);
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      setTimeout(checkRedirect, 100);
    };

    // Also listen to popstate (back/forward buttons)
    window.addEventListener("popstate", () => setTimeout(checkRedirect, 100), { signal });
  }

  // ── Video Speed Control (Pardon) ───────────────────────────────────────────
  // Press , or v (slower) / . or b (faster) to adjust video speed. Speed adjustments are
  // remembered as "difficulty markers" and auto-applied during playback.

  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const renderTime = (t) =>
    [(t / 3600) | 0, ((t / 60) | 0) % 60, (t % 60) | 0]
      .map((e) => e.toString().padStart(2, "0"))
      .join(":");
  const renderSpeed = (s) => "x" + s.toFixed(2);

  function centerTooltip(textContent) {
    const el = document.createElement("div");
    el.textContent = textContent;
    el.style.cssText =
      "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); " +
      "background: #0008; color: white; padding: 0.5rem; border-radius: 1rem; " +
      "z-index: 2147483647; pointer-events: none;";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 500);
  }

  // Speed map: WeakMap<videoElement, Map<timestamp, speed>>
  const videoSpeedMaps = new WeakMap();

  // GM_setValue cache helpers for persistent storage
  const markerCacheKey = (url) => `lk:markers:${normalizeUrl(url)}`;

  function loadLocalMarkers(url) {
    try {
      const raw = GM_getValue(markerCacheKey(url), "");
      if (!raw) return { markers: {}, lastSync: 0, dirty: false };
      return JSON.parse(raw);
    } catch {
      return { markers: {}, lastSync: 0, dirty: false };
    }
  }

  function saveLocalMarkers(url, markers, dirty = true) {
    const cache = {
      markers,
      lastSync: dirty ? loadLocalMarkers(url).lastSync : Date.now(),
      dirty,
    };
    GM_setValue(markerCacheKey(url), JSON.stringify(cache));
  }

  async function pardon(dt = 0, speedMultiplier = 1, wait = 0) {
    const vs = $$("video,audio");
    const v = vs.filter((e) => !e.paused)[0];
    if (!v) return vs[0]?.click();

    // Helper to merge nearby markers (within 2 seconds)
    const mergeNearbyMarkers = (time) => {
      if (speedMultiplier === 1) return; // Only merge when speed is being adjusted
      if (!videoSpeedMaps.has(v)) videoSpeedMaps.set(v, new Map());
      const speedMap = videoSpeedMaps.get(v);
      const MERGE_THRESHOLD = 2.0; // seconds
      for (const [existingTime] of speedMap) {
        if (Math.abs(time - existingTime) < MERGE_THRESHOLD) {
          speedMap.delete(existingTime);
          console.log(`[Lianki] Merged marker: ${renderTime(existingTime)} @ ${renderTime(time)}`);
        }
      }
    };

    // Merge at original position BEFORE time adjustment
    mergeNearbyMarkers(v.currentTime);

    if (dt !== 0) v.currentTime += dt;

    // Merge at destination position AFTER time adjustment
    mergeNearbyMarkers(v.currentTime);

    if (speedMultiplier !== 1) {
      v.playbackRate *= speedMultiplier;

      // Speed map already initialized by mergeNearbyMarkers
      const speedMap = videoSpeedMaps.get(v);

      // Add new marker at final position
      speedMap.set(v.currentTime, v.playbackRate);
      console.log(
        `[Lianki] Speed marker: ${renderTime(v.currentTime)} → ${renderSpeed(v.playbackRate)}`,
      );

      // Save to local cache (GM_setValue)
      const url = normalizeUrl(location.href);
      const markers = Object.fromEntries(speedMap);
      saveLocalMarkers(url, markers, true); // dirty = true
    }

    centerTooltip(
      (dt < 0 ? "<-" : "->") + " " + renderTime(v.currentTime) + " " + renderSpeed(v.playbackRate),
    );

    if (wait) await sleep(wait);
    return true;
  }

  // Keyboard shortcuts for video speed control
  window.addEventListener(
    "keydown",
    async (e) => {
      // Skip if Lianki dialog is open or in input fields
      if (dialog) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (document?.activeElement?.isContentEditable) return;
      if (["INPUT", "TEXTAREA"].includes(document?.activeElement?.tagName)) return;

      if (e.code === "Comma" || e.code === "KeyV") {
        if (await pardon(-3, 0.7)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
      if (e.code === "Period" || e.code === "KeyB") {
        if (await pardon(0, 1.2)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    },
    { capture: true },
  );

  // Auto-adjust speed at marked timestamps
  function setupVideoSpeedTracking(video) {
    const url = normalizeUrl(location.href);

    // Load markers from DB → GM_setValue → WeakMap
    (async () => {
      try {
        const local = loadLocalMarkers(url);

        // Always fetch from DB for cross-device sync
        const { markers } = await api(`/api/fsrs/speed-markers?url=${encodeURIComponent(url)}`);

        // Merge: server wins for conflicts, use latest
        const merged = { ...local.markers, ...markers };

        // Save to local cache
        saveLocalMarkers(url, merged, false); // not dirty, just synced

        // Load into WeakMap for this video
        if (!videoSpeedMaps.has(video)) videoSpeedMaps.set(video, new Map());
        const speedMap = videoSpeedMaps.get(video);
        for (const [timestamp, speed] of Object.entries(merged)) {
          speedMap.set(parseFloat(timestamp), speed);
        }

        console.log(`[Lianki] Loaded ${Object.keys(merged).length} speed markers for ${url}`);
      } catch (err) {
        console.error("[Lianki] Failed to load speed markers:", err);
        // Fall back to local cache
        const local = loadLocalMarkers(url);
        if (!videoSpeedMaps.has(video)) videoSpeedMaps.set(video, new Map());
        const speedMap = videoSpeedMaps.get(video);
        for (const [timestamp, speed] of Object.entries(local.markers)) {
          speedMap.set(parseFloat(timestamp), speed);
        }
      }
    })();

    let lastCheckedTime = 0;

    video.addEventListener("timeupdate", () => {
      const speedMap = videoSpeedMaps.get(video);
      if (!speedMap || speedMap.size === 0) return;

      const currentTime = video.currentTime;
      const threshold = 0.5; // 500ms window

      // Only check if we've moved significantly (avoid spam)
      if (Math.abs(currentTime - lastCheckedTime) < 0.3) return;
      lastCheckedTime = currentTime;

      // Find nearest marker
      for (const [markedTime, targetSpeed] of speedMap) {
        if (Math.abs(currentTime - markedTime) < threshold) {
          if (Math.abs(video.playbackRate - targetSpeed) > 0.01) {
            video.playbackRate = targetSpeed;
            centerTooltip(`Auto-speed: ${renderSpeed(targetSpeed)} @ ${renderTime(markedTime)}`);
            console.log(
              `[Lianki] Auto-adjusted to ${renderSpeed(targetSpeed)} at ${renderTime(currentTime)}`,
            );
          }
          break; // Only apply one marker per check
        }
      }
    });
  }

  // Detect and track all video/audio elements
  function observeVideos() {
    const tracked = new WeakSet();

    const trackVideo = (v) => {
      if (tracked.has(v)) return;
      tracked.add(v);
      setupVideoSpeedTracking(v);
    };

    // Track existing videos
    $$("video,audio").forEach(trackVideo);

    // Track future videos
    const observer = new MutationObserver(() => {
      $$("video,audio").forEach(trackVideo);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  observeVideos();

  // Periodic sync to DB (every 30s)
  setInterval(async () => {
    try {
      const url = normalizeUrl(location.href);
      const cache = loadLocalMarkers(url);

      if (!cache.dirty) return; // No changes to sync

      console.log(`[Lianki] Syncing ${Object.keys(cache.markers).length} markers to DB...`);

      await api("/api/fsrs/speed-markers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, markers: cache.markers }),
      });

      // Mark as synced
      saveLocalMarkers(url, cache.markers, false); // dirty = false
      console.log("[Lianki] Sync complete");
    } catch (err) {
      console.error("[Lianki] Sync failed:", err);
      // Keep dirty flag, will retry in 30s
    }
  }, 30_000); // 30 seconds

  // ── Cleanup ────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────────────
  // Offline-First Integration
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Offline-First Integration for lianki.user.js
   *
   * This code is inserted into main() to wire up offline functionality.
   * It modifies openDialog() and doReview() to use GM_setValue cache.
   */

  // ── Offline Storage Initialization ──────────────────────────────────────────
  let offlineReady = false;
  let cardStorage, configStorage, queueStorage, localFSRS;
  const deviceId = getOrCreateDeviceId();
  let syncInProgress = false;
  let syncTimer = null;

  // Initialize offline storage (GM_setValue is synchronous — always ready)
  function initOfflineStorage() {
    try {
      cardStorage = new GMCardStorage();
      configStorage = new GMConfigStorage();
      queueStorage = new GMQueueStorage();

      // Load FSRS parameters
      const config = configStorage.getConfig();
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

    // Offline-first: Check GM cache
    if (offlineReady) {
      try {
        const cachedCard = cardStorage.getCard(url);

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
            cardStorage.setCard(url, note, note.hlc ?? newHLC(deviceId, null));
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
        // Guest mode: 401 → create local-only card
        if (
          offlineReady &&
          (err?.status === 401 ||
            String(err?.message).includes("401") ||
            String(err?.message).toLowerCase().includes("unauthorized"))
        ) {
          const localNote = {
            _id: "local:" + hashUrl(url),
            url,
            title: document.title,
            card: localFSRS.newCard(),
            notes: "",
            hlc: newHLC(deviceId, null),
          };
          cardStorage.setCard(url, localNote, localNote.hlc, true);
          queueStorage.addToQueue("add", { url, title: document.title }, localNote.hlc);
          state.noteId = localNote._id;
          state.notes = "";
          state.notesSynced = false;
          state.phase = "reviewing";
          state.options = localFSRS.calculateOptions(localNote.card);
          renderDialog();
          return;
        }
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
        const cachedCard = cardStorage.getCard(url);

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
          cardStorage.setCard(url, cachedCard.note, newHlc, true); // dirty = true

          // Queue for server sync
          queueStorage.addToQueue(
            "review",
            {
              url,
              noteId: state.noteId,
              rating,
            },
            newHlc,
          );

          // Find next due card from local cache (excluding the just-reviewed card)
          // Must set prefetchedNextUrl BEFORE afterReview(), because the server
          // hasn't received this review yet and would return the same card.
          try {
            const dueCards = cardStorage.getDueCards(2);
            const normalizedCurrent = normalizeUrl(location.href);
            const nextCard = dueCards.find((c) => c.url !== url && c.url !== normalizedCurrent);
            prefetchedNextUrl = nextCard?.url ?? null;
            if (prefetchedNextUrl) prefetchNextPage(prefetchedNextUrl);
          } catch (e) {
            prefetchedNextUrl = null;
          }

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
          const cachedCard = cardStorage.getCard(url);
          if (cachedCard) {
            cachedCard.note.card = result.card;
            cachedCard.note.log = result.log || cachedCard.note.log;
            cardStorage.setCard(url, cachedCard.note, result.hlc);
          }
        } catch (err) {
          console.error("[Lianki] Failed to update cache:", err);
        }
      }

      // Always update from server (even null) to prevent stale value re-navigating to current card
      prefetchedNextUrl = result.nextUrl ?? null;
      if (result.nextUrl) prefetchNextPage(result.nextUrl);

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

  /**
   * Take the server's version after a 409.
   *
   * The conflict response already carries `card`, `log` and `serverHLC`, so the
   * losing client has everything it needs to converge immediately. Dropping the
   * queue item without this would leave the local copy permanently behind and
   * marked dirty, which is what made a card look "stuck": reviewed locally,
   * never reconciled, forever pending.
   */
  function adoptServerVersion(item, body) {
    const url = item?.data?.url;
    if (!url || !body?.card) return;
    try {
      const existing = cardStorage.getEntry ? cardStorage.getEntry(url) : cardStorage.getCard(url);
      const note = { ...existing?.note, url, card: body.card, log: body.log ?? [] };
      cardStorage.setCard(url, note, body.serverHLC ?? existing?.hlc ?? null, false);
    } catch (e) {
      console.error("[Lianki] could not adopt server version for", url, e);
    }
  }

  async function tryBackgroundSync() {
    if (syncInProgress || !offlineReady) return;
    if (!navigator.onLine) {
      console.log("[Lianki] Offline - will sync when online");
      return;
    }

    syncInProgress = true;

    try {
      const queue = queueStorage.getQueue();

      if (queue.length === 0) {
        syncInProgress = false;
        return;
      }

      console.log(`[Lianki] Syncing ${queue.length} pending updates...`);

      // Sync in order (HLC sorted)
      for (const item of queue) {
        try {
          await syncQueueItem(item);
          queueStorage.removeFromQueue(item.id);
          console.log(`[Lianki] Synced: ${item.action} ${item.data.url || item.data.noteId}`);
        } catch (err) {
          const status = err?.status;

          // Classify, do not just count.
          //
          // Every failure used to be treated as transient: bump `retries`, drop
          // after 5. But a 409 ("Server has newer version") and a 404 (the note
          // is gone) can never succeed on a repeat — nothing about trying again
          // changes the server's answer. They burned retries they should never
          // have been given, and because `retries` is a read-modify-write on GM
          // storage shared by every open tab, concurrent tabs lost increments
          // and dead items were retried into the hundreds. Measured on a real
          // browser: one item failed 237 times, and 73 of 230 cards sat
          // unsynced behind the jam.
          //
          const permanent = isPermanentSyncFailure(status);

          if (status === 409) {
            // The server already sent us what it has; adopt it rather than
            // discarding the response and asking again.
            adoptServerVersion(item, err.body);
            queueStorage.removeFromQueue(item.id);
            console.warn(`[Lianki] ${item.id}: server had a newer version — adopted it`);
          } else if (permanent) {
            queueStorage.removeFromQueue(item.id);
            console.warn(`[Lianki] Dropping ${item.id}: HTTP ${status} will not succeed on retry`);
          } else {
            console.error(`[Lianki] Sync failed for ${item.id}:`, err);
            item.retries = (item.retries || 0) + 1;
            if (item.retries > 5) {
              console.warn(`[Lianki] Dropping ${item.id} after 5 retries`);
              queueStorage.removeFromQueue(item.id);
            } else {
              queueStorage.updateQueueItem(item.id, { retries: item.retries });
            }
          }
        }
      }

      // Update last sync time
      configStorage.updateLastSync(newHLC(deviceId, null));

      console.log("[Lianki] Sync complete");
    } finally {
      syncInProgress = false;
    }
  }

  async function syncQueueItem(item) {
    switch (item.action) {
      case "review": {
        const result = await api(
          `/api/fsrs/review/${item.data.rating}/?id=${encodeURIComponent(item.data.noteId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hlc: item.hlc }),
          },
        );
        // Clear dirty flag so the card shows as synced in IDB
        if (item.data.url) {
          const cached = cardStorage.getCard(item.data.url);
          if (cached) {
            if (result?.card) cached.note.card = result.card;
            cardStorage.setCard(item.data.url, cached.note, result?.hlc ?? item.hlc, false);
          }
        }
        break;
      }

      case "add": {
        const addResult = await addNote(item.data.url, item.data.title);
        // Update local card with server-assigned ID and clear dirty flag
        if (addResult && item.data.url) {
          const cached = cardStorage.getCard(item.data.url);
          if (cached) {
            if (addResult._id) cached.note._id = addResult._id;
            cardStorage.setCard(item.data.url, cached.note, addResult.hlc ?? item.hlc, false);
          }
        }
        break;
      }

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
          // getEntry, not getCard: a tombstone must be visible here. getCard
          // hides it, which made every prefetch look like "no local copy" and
          // put the deleted card straight back — delete, resurrect, repeat.
          const existing = cardStorage.getEntry(url);

          // Soft-delete vs incoming card: last write wins (docs/sync-merge-rules.md).
          // A genuinely newer server card resurrects — that is an edit made
          // after the delete — but a stale one never does.
          if (!existing || compareHLC(note.hlc, existing.hlc) > 0) {
            cardStorage.setCard(
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
      const dueCards = cardStorage.getDueCards(2);
      const normalizedCurrent = normalizeUrl(location.href);
      const nextCard = dueCards.find((c) => c.url !== normalizedCurrent);
      if (nextCard) {
        prefetchNextPage(nextCard.url);
      }
    } catch (err) {
      console.error("[Lianki] Failed to prefetch next cached card:", err);
    }
  }

  // ── Initialize on startup ────────────────────────────────────────────────────
  // GM_setValue is synchronous — call directly after api() is defined
  setTimeout(() => {
    initOfflineStorage();
  }, 100);

  return () => {
    ac.abort();
    closeDialog();
    videoObserver?.disconnect();
    fab?.remove();
    fab = null;
  };
}
