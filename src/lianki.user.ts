// ==UserScript==
// @name        Lianki
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_info
// @version     2.21.11
// @author      lianki.com
// @description Lianki spaced repetition — offline-first with IndexedDB sync. Press , or . (or media keys) to control video speed with difficulty markers.
// @run-at      document-end
// @downloadURL https://www.lianki.com/lianki.user.js
// @updateURL   https://www.lianki.com/lianki.meta.js
// @connect     lianki.com
// @connect     www.lianki.com
// @connect     beta.lianki.com
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
const MAX_CARDS = 2000;

function hashUrl(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
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
    return c._url === url ? c : null; // hash collision guard
  }

  setCard(url, note, hlc, dirty = false) {
    const hash = hashUrl(url);
    const key = CARD_PREFIX + hash;
    let idx = this._index();
    const pos = idx.findIndex((e) => e.url === url);
    const entry = { url, due: note.card.due, hash };
    if (pos >= 0) {
      idx[pos] = entry;
    } else {
      if (idx.length >= MAX_CARDS) {
        // LDF: evict furthest due
        const maxI = idx.reduce(
          (mi, e, i, a) => (new Date(e.due) > new Date(a[mi].due) ? i : mi),
          0,
        );
        GM_deleteValue(CARD_PREFIX + idx[maxI].hash);
        idx.splice(maxI, 1);
      }
      idx.push(entry);
    }
    this._saveIndex(idx);
    GM_setValue(key, JSON.stringify({ _url: url, note, hlc, dirty }));
  }

  deleteCard(url) {
    GM_deleteValue(CARD_PREFIX + hashUrl(url));
    this._saveIndex(this._index().filter((e) => e.url !== url));
  }

  getAllCards() {
    return this._index()
      .map((e) => {
        const raw = GM_getValue(CARD_PREFIX + e.hash, "");
        return raw ? { url: e.url, ...JSON.parse(raw) } : null;
      })
      .filter(Boolean);
  }

  getDueCards(limit = 10) {
    const now = new Date();
    return this._index()
      .filter((e) => new Date(e.due) <= now)
      .sort((a, b) => new Date(a.due) - new Date(b.due))
      .slice(0, limit)
      .map((e) => {
        const raw = GM_getValue(CARD_PREFIX + e.hash, "");
        return raw ? { url: e.url, ...JSON.parse(raw) } : null;
      })
      .filter(Boolean);
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

async function syncToSiteDB() {
  const cs = new GMCardStorage();
  const index = cs._index();
  if (!index.length) return;
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("lianki-keyval", 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore("keyval");
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    const tx = db.transaction("keyval", "readwrite");
    const store = tx.objectStore("keyval");
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
  // Auto-detected from @downloadURL so beta.lianki.com works too.
  // Normalize bare lianki.com → www.lianki.com: __Host- cookies bind to exact hostname.
  const ORIGIN = (() => {
    try {
      const u = new URL(GM_info?.script?.downloadURL || "");
      if (u.hostname === "lianki.com") u.hostname = "www.lianki.com";
      return u.origin;
    } catch {
      return "https://www.lianki.com";
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
      // Strip tracking & session params
      for (const p of [
        "si",
        "pp",
        "feature",
        "ref",
        "source",
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

  // On the Lianki site itself: sync GM cards to IndexedDB for offline display, then exit
  if (location.hostname === new URL(ORIGIN).hostname) {
    setTimeout(() => syncToSiteDB(), 500);
    return () => {};
  }

  const ac = new AbortController();
  const { signal } = ac;

  // ── Constants ──────────────────────────────────────────────────────────────
  const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  // User preferences (loaded from API)
  let userPreferences = {
    mobileExcludeDomains: [], // default: no filters
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
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
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

  // Build excludeDomains query param for filtering next card
  const buildExcludeDomainsParam = () => {
    if (!isMobile) return "";
    const domains = userPreferences.mobileExcludeDomains || [];
    if (domains.length === 0) return "";
    return `&excludeDomains=${domains.join(",")}`;
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

      const tokenBtn = document.createElement("button");
      tokenBtn.setAttribute("style", btn("#3a6f3f"));
      tokenBtn.textContent = "Set API Token";
      tokenBtn.addEventListener("click", () => {
        const token = prompt(
          `Paste your Lianki API token.\n\nGenerate one at: ${ORIGIN}/list\n\n(Needed for Safari/Stay where cookies don't work)`,
        );
        if (!token) return;
        GM_setValue("lk:token", token.trim());
        closeDialog();
        openDialog(); // retry with token
      });
      btnRow.appendChild(tokenBtn);

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
          pardon(-3, 0.7); // Rewind 3s and slower
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
          console.error(`[Lianki] Sync failed for ${item.id}:`, err);

          // Increment retry count
          item.retries = (item.retries || 0) + 1;

          if (item.retries > 5) {
            console.warn(`[Lianki] Dropping ${item.id} after 5 retries`);
            queueStorage.removeFromQueue(item.id);
          } else {
            queueStorage.updateQueueItem(item.id, { retries: item.retries });
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
          const existing = cardStorage.getCard(url);

          // Update if server version is newer or doesn't exist
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
