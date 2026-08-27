"use client";

/**
 * The "Local" store: the `lianki-keyval` IndexedDB database on lianki.com.
 *
 * This is a mirror the userscript writes in `syncToSiteDB()` — cards live under
 * `card:<url>` keys and the GM-storage card count under `meta:gm-count`. It is
 * the only one of the three stores the page itself can read: "Script" is
 * Tampermonkey `GM_setValue` (not page-accessible; it only leaves a summary in
 * `localStorage["lk:status"]`) and "Cloud" is server-side.
 *
 * Every reader of that schema goes through this module so the key layout is
 * described in exactly one place.
 */

export const LOCAL_DB_NAME = "lianki-keyval";
export const LOCAL_STORE_NAME = "keyval";
export const CARD_KEY_PREFIX = "card:";
export const GM_COUNT_KEY = "meta:gm-count";
export const USERSCRIPT_STATUS_KEY = "lk:status";

/** A card as the userscript mirrors it into IndexedDB. */
export type LocalCard = {
  url: string;
  title?: string;
  card: {
    due: string | Date;
    stability: number;
    difficulty: number;
    elapsed_days: number;
    scheduled_days: number;
    reps: number;
    lapses: number;
    state: number;
    last_review?: string | Date;
  };
  log?: Record<string, unknown>[];
  hlc?: { timestamp: number; counter: number; deviceId: string };
  /** false when the userscript still has the card queued for the server. */
  synced?: boolean;
};

/** The summary the userscript drops in localStorage for the Script store. */
export type UserscriptStatus = {
  version: string;
  cardCount: number;
  dueCount: number;
  lastSync: number;
};

async function openLocalDB() {
  const { openDB } = await import("idb");
  return openDB(LOCAL_DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(LOCAL_STORE_NAME)) db.createObjectStore(LOCAL_STORE_NAME);
    },
  });
}

export type LocalSnapshot = {
  cards: LocalCard[];
  /** Card count the userscript last reported for its own GM store. */
  gmCount: number | null;
};

/** Read every mirrored card plus the GM-store count, due-date ascending. */
export async function readLocalStore(): Promise<LocalSnapshot> {
  const db = await openLocalDB();
  try {
    const tx = db.transaction(LOCAL_STORE_NAME, "readonly");
    const store = tx.objectStore(LOCAL_STORE_NAME);
    const [keys, gm] = await Promise.all([store.getAllKeys(), store.get(GM_COUNT_KEY)]);
    const cards: LocalCard[] = [];
    for (const key of keys) {
      if (typeof key !== "string" || !key.startsWith(CARD_KEY_PREFIX)) continue;
      const value = (await store.get(key)) as LocalCard | undefined;
      if (value?.card) cards.push(value);
    }
    await tx.done;
    cards.sort((a, b) => +new Date(a.card.due) - +new Date(b.card.due));
    return { cards, gmCount: typeof gm === "number" ? gm : null };
  } finally {
    db.close();
  }
}

/** Delete the given urls from the mirror. Returns how many keys went away. */
export async function deleteLocalCards(urls: string[]): Promise<number> {
  if (!urls.length) return 0;
  const db = await openLocalDB();
  try {
    const tx = db.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = tx.objectStore(LOCAL_STORE_NAME);
    let deleted = 0;
    for (const url of urls) {
      const key = CARD_KEY_PREFIX + url;
      if ((await store.get(key)) !== undefined) {
        await store.delete(key);
        deleted++;
      }
    }
    await tx.done;
    return deleted;
  } finally {
    db.close();
  }
}

/**
 * Drop every mirrored card and the GM count.
 *
 * This only clears the *mirror*: the userscript's own GM storage is untouched
 * and will repopulate it on its next visit to lianki.com. Say so in the UI.
 */
export async function wipeLocalStore(): Promise<number> {
  const db = await openLocalDB();
  try {
    const tx = db.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = tx.objectStore(LOCAL_STORE_NAME);
    const keys = await store.getAllKeys();
    let deleted = 0;
    for (const key of keys) {
      if (typeof key !== "string") continue;
      if (key.startsWith(CARD_KEY_PREFIX)) deleted++;
      else if (key !== GM_COUNT_KEY) continue;
      await store.delete(key);
    }
    await tx.done;
    return deleted;
  } finally {
    db.close();
  }
}

/** The Script store's self-report, or null when the userscript never ran here. */
export function readUserscriptStatus(): UserscriptStatus | null {
  try {
    const raw = localStorage.getItem(USERSCRIPT_STATUS_KEY);
    return raw ? (JSON.parse(raw) as UserscriptStatus) : null;
  } catch {
    return null;
  }
}
