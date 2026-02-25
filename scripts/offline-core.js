/**
 * Offline-First Core for Lianki Userscript
 *
 * This file contains:
 * - Hybrid Logical Clock (HLC) implementation
 * - IndexedDB storage layer
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
// IndexedDB Storage Layer (using bundled idb-keyval)
// ============================================================================

/**
 * Initialize IndexedDB stores
 * Returns { cardStore, configStore, queueStore }
 */
function initStores() {
  const { createStore } = window.LiankiDeps;

  return {
    cardStore: createStore("lianki-cards", "cards"),
    configStore: createStore("lianki-config", "config"),
    queueStore: createStore("lianki-queue", "queue"),
  };
}

/**
 * @typedef {Object} CachedCard
 * @property {Object} note - FSRSNote
 * @property {HLC} hlc - Hybrid Logical Clock
 * @property {boolean} dirty - Has pending server sync
 */

/**
 * Card storage helpers
 */
class CardStorage {
  constructor(stores, deviceId) {
    this.stores = stores;
    this.deviceId = deviceId;
    const { get, set, keys, del } = window.LiankiDeps;
    this.get = get;
    this.set = set;
    this.keys = keys;
    this.del = del;
  }

  async getCard(url) {
    return await this.get(url, this.stores.cardStore);
  }

  async setCard(url, note, hlc = null, dirty = false) {
    const cachedCard = {
      note,
      hlc: hlc || newHLC(this.deviceId, null),
      dirty,
    };
    await this.set(url, cachedCard, this.stores.cardStore);
    return cachedCard;
  }

  async deleteCard(url) {
    await this.del(url, this.stores.cardStore);
  }

  async getAllCards() {
    const urls = await this.keys(this.stores.cardStore);
    const cards = [];

    for (const url of urls) {
      const card = await this.getCard(url);
      if (card) cards.push({ url, ...card });
    }

    return cards;
  }

  async getDueCards(limit = 10) {
    const all = await this.getAllCards();
    const now = new Date();

    // Filter due cards
    const due = all.filter((c) => new Date(c.note.card.due) <= now);

    // Sort by due date (earliest first)
    due.sort((a, b) => new Date(a.note.card.due) - new Date(b.note.card.due));

    return due.slice(0, limit);
  }
}

/**
 * Config storage
 */
class ConfigStorage {
  constructor(stores) {
    this.stores = stores;
    const { get, set } = window.LiankiDeps;
    this.get = get;
    this.set = set;
  }

  async getConfig() {
    let config = await this.get("config", this.stores.configStore);

    if (!config) {
      config = {
        fsrsParams: null,
        deviceId: getOrCreateDeviceId(),
        lastSyncHLC: null,
        lastSyncTime: 0,
      };
      await this.setConfig(config);
    }

    return config;
  }

  async setConfig(config) {
    await this.set("config", config, this.stores.configStore);
  }

  async updateLastSync(hlc) {
    const config = await this.getConfig();
    config.lastSyncHLC = hlc;
    config.lastSyncTime = Date.now();
    await this.setConfig(config);
  }
}

/**
 * Sync queue storage
 */
class QueueStorage {
  constructor(stores) {
    this.stores = stores;
    const { get, set, keys, del } = window.LiankiDeps;
    this.get = get;
    this.set = set;
    this.keys = keys;
    this.del = del;
  }

  async addToQueue(action, data, hlc) {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const item = {
      id,
      action,
      data,
      hlc,
      retries: 0,
      createdAt: Date.now(),
    };

    await this.set(id, item, this.stores.queueStore);
    return id;
  }

  async getQueue() {
    const queueKeys = await this.keys(this.stores.queueStore);
    const queue = [];

    for (const key of queueKeys) {
      const item = await this.get(key, this.stores.queueStore);
      if (item) queue.push(item);
    }

    // Sort by HLC (oldest first)
    queue.sort((a, b) => compareHLC(a.hlc, b.hlc));

    return queue;
  }

  async removeFromQueue(id) {
    await this.del(id, this.stores.queueStore);
  }

  async updateQueueItem(id, updates) {
    const item = await this.get(id, this.stores.queueStore);
    if (item) {
      await this.set(id, { ...item, ...updates }, this.stores.queueStore);
    }
  }
}

// ============================================================================
// Local FSRS Calculations (using bundled ts-fsrs)
// ============================================================================

class LocalFSRS {
  constructor(params = null) {
    const { fsrs, generatorParameters, Rating } = window.LiankiDeps;

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
        card: scheduleInfo[this.Rating.Again].card,
        log: scheduleInfo[this.Rating.Again].log,
        due: this.formatDue(scheduleInfo[this.Rating.Again].card.due),
      },
      {
        rating: 2,
        card: scheduleInfo[this.Rating.Hard].card,
        log: scheduleInfo[this.Rating.Hard].log,
        due: this.formatDue(scheduleInfo[this.Rating.Hard].card.due),
      },
      {
        rating: 3,
        card: scheduleInfo[this.Rating.Good].card,
        log: scheduleInfo[this.Rating.Good].log,
        due: this.formatDue(scheduleInfo[this.Rating.Good].card.due),
      },
      {
        rating: 4,
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

// Export for use in main userscript
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    compareHLC,
    newHLC,
    getOrCreateDeviceId,
    initStores,
    CardStorage,
    ConfigStorage,
    QueueStorage,
    LocalFSRS,
  };
}
