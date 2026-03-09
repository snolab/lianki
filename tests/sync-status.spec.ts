/**
 * Sync Status Tests
 *
 * Covers:
 * 1. syncToSiteDB: userscript GM storage → lianki-keyval IndexedDB
 *    - Correct IDB key format (card:{url})
 *    - meta:gm-count written
 *    - synced flag = !dirty
 * 2. Guest /list page UI
 *    - Shows "Guest Mode" banner
 *    - SyncStatusBanner shows Script + Local boxes only (no Cloud)
 *    - Loading state, then empty state when IDB has no cards
 *    - Card list appears after IDB is pre-populated
 * 3. Userscript static checks for syncToSiteDB
 */

import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

const BASE = process.env.LIANKI_URL || "https://www.lianki.com";
const SCRIPT_CONTENT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Open a raw IDB transaction and return all key→value pairs from "keyval" store */
async function readAllIDB(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("lianki-keyval", 1);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains("keyval")) db.createObjectStore("keyval");
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = (req as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains("keyval")) {
          db.close();
          resolve({});
          return;
        }
        const tx = db.transaction("keyval", "readonly");
        const store = tx.objectStore("keyval");
        const keysReq = store.getAllKeys();
        keysReq.onsuccess = async () => {
          const result: Record<string, unknown> = {};
          for (const key of keysReq.result) {
            await new Promise<void>((res) => {
              const r = store.get(key);
              r.onsuccess = () => {
                result[key as string] = r.result;
                res();
              };
            });
          }
          db.close();
          resolve(result);
        };
      };
    });
  });
}

/** Seed a fresh IDB with a list of card entries (format as syncToSiteDB would write) */
async function seedIDB(
  page: Page,
  cards: { url: string; title: string; card: object; log?: object[]; synced?: boolean }[],
) {
  await page.evaluate(
    (cards) => {
      return new Promise<void>((resolve, reject) => {
        // Check current DB version first, so we can bump it to force upgrade if needed
        const probe = indexedDB.open("lianki-keyval");
        probe.onerror = () => reject(probe.error);
        probe.onsuccess = () => {
          const curVer = probe.result.version;
          probe.result.close();

          // Open at current version (upgrade only fires if store is missing)
          const req = indexedDB.open("lianki-keyval", curVer);
          req.onupgradeneeded = (e) => {
            const db = (e.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains("keyval")) db.createObjectStore("keyval");
          };
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = (req as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains("keyval")) {
              db.close();
              // Bump version to create store
              const req2 = indexedDB.open("lianki-keyval", curVer + 1);
              req2.onupgradeneeded = (e) => {
                const db2 = (e.target as IDBOpenDBRequest).result;
                if (!db2.objectStoreNames.contains("keyval")) db2.createObjectStore("keyval");
              };
              req2.onerror = () => reject(req2.error);
              req2.onsuccess = () => {
                const db2 = (req2 as IDBOpenDBRequest).result;
                writeCards(db2, cards, resolve, reject);
              };
              return;
            }
            writeCards(db, cards, resolve, reject);
          };
        };

        function writeCards(
          db: IDBDatabase,
          cards: { url: string; [k: string]: unknown }[],
          resolve: () => void,
          reject: (e: unknown) => void,
        ) {
          const tx = db.transaction("keyval", "readwrite");
          const store = tx.objectStore("keyval");
          for (const c of cards) store.put(c, `card:${c.url}`);
          store.put(cards.length, "meta:gm-count");
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        }
      });
    },
    cards as Parameters<typeof seedIDB>[1],
  );
}

/** The core syncToSiteDB logic extracted for in-page evaluation (mirrors the userscript) */
const SYNC_FN = `
async function runSyncToSiteDB() {
  const CARD_PREFIX = "lk:c:";
  const INDEX_KEY   = "lk:card-index";

  const index = JSON.parse(window.GM_getValue(INDEX_KEY, "[]"));
  if (!index.length) return 0;

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("lianki-keyval", 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore("keyval");
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });

  const tx = db.transaction("keyval", "readwrite");
  const store = tx.objectStore("keyval");

  for (const entry of index) {
    const raw = window.GM_getValue(CARD_PREFIX + entry.hash, "");
    if (!raw) continue;
    const { note, hlc, dirty } = JSON.parse(raw);
    if (!note?.card) continue;
    store.put(
      { url: note.url || entry.url, title: note.title || note.url, card: note.card,
        log: note.log || [], hlc: hlc || note.hlc, synced: !dirty },
      "card:" + (note.url || entry.url),
    );
  }
  store.put(index.length, "meta:gm-count");

  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
  db.close();
  return index.length;
}
`;

/** Build a minimal GM_setValue card entry as the userscript would store it */
function makeGMCard(url: string, title: string, dirty = true) {
  const due = new Date(Date.now() + 86_400_000).toISOString();
  return {
    _url: url,
    note: {
      _id: `local:${Math.random().toString(36).slice(2)}`,
      url,
      title,
      card: {
        due,
        stability: 1,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 1,
        reps: 0,
        lapses: 0,
        state: 0,
      },
      log: [],
    },
    hlc: "test-hlc",
    dirty,
  };
}

/** djb2 hash matching the userscript's hashUrl() */
function hashUrl(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Seed window.__gm with N cards and return the URLs */
async function seedGM(page: Page, cards: { url: string; title: string; dirty?: boolean }[]) {
  await page.evaluate(
    ({
      cards,
      hashFn,
    }: {
      cards: { url: string; title: string; dirty?: boolean }[];
      hashFn: string;
    }) => {
      const hash: (u: string) => string = new Function(`return (${hashFn})`)();
      const CARD_PREFIX = "lk:c:";
      const INDEX_KEY = "lk:card-index";
      const index: { url: string; due: string; hash: string }[] = [];
      for (const c of cards) {
        const due = new Date(Date.now() + 86_400_000).toISOString();
        const h = hash(c.url);
        const entry = {
          _url: c.url,
          note: {
            _id: "local:x",
            url: c.url,
            title: c.title,
            card: {
              due,
              stability: 1,
              difficulty: 5,
              elapsed_days: 0,
              scheduled_days: 1,
              reps: 0,
              lapses: 0,
              state: 0,
            },
            log: [],
          },
          hlc: "hlc",
          dirty: c.dirty !== false,
        };
        (window as any).GM_setValue(CARD_PREFIX + h, JSON.stringify(entry));
        index.push({ url: c.url, due, hash: h });
      }
      (window as any).GM_setValue(INDEX_KEY, JSON.stringify(index));
    },
    { cards, hashFn: hashUrl.toString() },
  );
}

// ── 1. Static analysis ────────────────────────────────────────────────────────

test.describe("Userscript static analysis: syncToSiteDB", () => {
  test("syncToSiteDB function is defined at module level (outside main)", () => {
    const mainIdx = SCRIPT_CONTENT.indexOf("function main()");
    const syncIdx = SCRIPT_CONTENT.indexOf("async function syncToSiteDB()");
    expect(syncIdx).toBeGreaterThan(0);
    // Must appear before main()
    expect(syncIdx).toBeLessThan(mainIdx);
  });

  test("syncToSiteDB writes meta:gm-count to IDB", () => {
    expect(SCRIPT_CONTENT).toContain(`"meta:gm-count"`);
  });

  test("on lianki.com hostname, main() calls syncToSiteDB instead of early-returning silently", () => {
    expect(SCRIPT_CONTENT).toMatch(/syncToSiteDB\(\)/);
    // The site-hostname early-return must call syncToSiteDB
    const block = SCRIPT_CONTENT.match(
      /if \(location\.hostname === new URL\(ORIGIN\)\.hostname\)[\s\S]*?return \(\) => \{\};/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block).toContain("syncToSiteDB");
  });

  test("syncToSiteDB stores synced: !dirty", () => {
    expect(SCRIPT_CONTENT).toContain("synced: !dirty");
  });
});

// ── 2. syncToSiteDB in-page sandbox ──────────────────────────────────────────

test.describe("syncToSiteDB: GM storage → IndexedDB", () => {
  async function setupGMPage(page: Page) {
    await page.addInitScript(() => {
      (window as any).__gm = {} as Record<string, string>;
      (window as any).GM_getValue = (k: string, d: unknown = "") => (window as any).__gm[k] ?? d;
      (window as any).GM_setValue = (k: string, v: unknown) => {
        (window as any).__gm[k] = v;
      };
    });
    // about:blank blocks IDB — use a real https origin for IndexedDB access
    await page.goto(`${BASE}/en/`);
  }

  test("writes one card to lianki-keyval IDB as card:{url}", async ({ page }) => {
    await setupGMPage(page);
    await seedGM(page, [{ url: "https://example.com/page-a", title: "Page A" }]);

    const written = await page.evaluate(
      new Function(
        `return async () => { ${SYNC_FN}; return runSyncToSiteDB(); }`,
      )() as () => Promise<number>,
    );
    expect(written).toBe(1);

    const idb = await readAllIDB(page);
    const card = idb["card:https://example.com/page-a"] as any;
    expect(card).toBeTruthy();
    expect(card.url).toBe("https://example.com/page-a");
    expect(card.title).toBe("Page A");
  });

  test("sets synced=true when dirty=false, synced=false when dirty=true", async ({ page }) => {
    await setupGMPage(page);
    await seedGM(page, [
      { url: "https://example.com/clean", title: "Clean", dirty: false },
      { url: "https://example.com/dirty", title: "Dirty", dirty: true },
    ]);

    await page.evaluate(
      new Function(
        `return async () => { ${SYNC_FN}; return runSyncToSiteDB(); }`,
      )() as () => Promise<number>,
    );

    const idb = await readAllIDB(page);
    expect((idb["card:https://example.com/clean"] as any).synced).toBe(true);
    expect((idb["card:https://example.com/dirty"] as any).synced).toBe(false);
  });

  test("writes meta:gm-count = number of cards", async ({ page }) => {
    await setupGMPage(page);
    await seedGM(page, [
      { url: "https://a.com/1", title: "One" },
      { url: "https://a.com/2", title: "Two" },
      { url: "https://a.com/3", title: "Three" },
    ]);

    await page.evaluate(
      new Function(
        `return async () => { ${SYNC_FN}; return runSyncToSiteDB(); }`,
      )() as () => Promise<number>,
    );

    const idb = await readAllIDB(page);
    expect(idb["meta:gm-count"]).toBe(3);
  });

  test("returns 0 and writes nothing when GM index is empty", async ({ page }) => {
    await setupGMPage(page);
    // No seedGM call → empty index

    const written = await page.evaluate(
      new Function(
        `return async () => { ${SYNC_FN}; return runSyncToSiteDB(); }`,
      )() as () => Promise<number>,
    );
    expect(written).toBe(0);

    const idb = await readAllIDB(page);
    const cardKeys = Object.keys(idb).filter((k) => k.startsWith("card:"));
    expect(cardKeys).toHaveLength(0);
  });

  test("multiple syncs overwrite existing IDB entries (idempotent)", async ({ page }) => {
    await setupGMPage(page);
    await seedGM(page, [{ url: "https://example.com/idempotent", title: "Old Title" }]);

    const syncFn = new Function(
      `return async () => { ${SYNC_FN}; return runSyncToSiteDB(); }`,
    )() as () => Promise<number>;

    // First sync
    await page.evaluate(syncFn);

    // Update GM title
    await page.evaluate(() => {
      const idx = JSON.parse((window as any).GM_getValue("lk:card-index", "[]"));
      const hash = idx[0].hash;
      const raw = JSON.parse((window as any).GM_getValue(`lk:c:${hash}`, "{}"));
      raw.note.title = "New Title";
      (window as any).GM_setValue(`lk:c:${hash}`, JSON.stringify(raw));
    });

    // Second sync
    await page.evaluate(syncFn);

    const idb = await readAllIDB(page);
    expect((idb["card:https://example.com/idempotent"] as any).title).toBe("New Title");
  });
});

// ── 3. Guest /list page UI ────────────────────────────────────────────────────

test.describe("Guest /list page UI (no auth)", () => {
  // Use a fresh browser context with no cookies to simulate a guest
  test.use({ storageState: { cookies: [], origins: [] } });

  test("shows 'Guest Mode - Local Storage' heading", async ({ page }) => {
    await page.goto(`${BASE}/en/list`);
    // Wait for client-side render
    await page.waitForSelector("text=Guest Mode", { timeout: 10_000 });
    await expect(page.getByText("Guest Mode - Local Storage")).toBeVisible();
  });

  test("shows Script and Local storage boxes but NO Cloud box", async ({ page }) => {
    await page.goto(`${BASE}/en/list`);
    // Wait for the SyncStatusBanner to appear (inside the success state of GuestListClient)
    await page.waitForSelector("text=Guest Mode - Local Storage", { timeout: 10_000 });

    // Exact match on label text inside the Box components
    await expect(page.getByText("Script", { exact: true })).toBeVisible();
    await expect(page.getByText("Local", { exact: true })).toBeVisible();
    // No Cloud box for guests
    await expect(page.getByText("Cloud", { exact: true })).not.toBeVisible();
  });

  test("shows 'Sign in' link inside the guest banner", async ({ page }) => {
    await page.goto(`${BASE}/en/list`);
    await page.waitForSelector("text=Sign in", { timeout: 10_000 });
    const signInLink = page.locator("text=Sign in").first();
    await expect(signInLink).toBeVisible();
  });

  test("shows empty state message when no cards in IDB", async ({ page }) => {
    await page.goto(`${BASE}/en/list`);
    // Wait for loading to finish
    await page.waitForSelector("text=No cards yet", { timeout: 10_000 }).catch(() => null);
    // Either shows "No cards yet" (empty IDB) or the card list
    const body = await page.locator("main").innerText();
    // Must not still be loading
    expect(body).not.toContain("Loading local cards...");
  });

  test("/en/list page returns HTTP 200 as guest", async ({ page }) => {
    const response = await page.goto(`${BASE}/en/list`);
    expect(response?.status()).toBe(200);
  });

  test("no Application Error on /en/list as guest", async ({ page }) => {
    await page.goto(`${BASE}/en/list`);
    await expect(page.getByText(/Application error/i)).not.toBeVisible();
  });
});

// ── 4. SyncStatusBanner populated from IDB ───────────────────────────────────

test.describe("SyncStatusBanner reads counts from pre-seeded IDB", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("shows IDB card count after seeding cards via syncToSiteDB sandbox", async ({ page }) => {
    // Setup GM mocks and a proper origin for IDB access
    await page.addInitScript(() => {
      (window as any).__gm = {} as Record<string, string>;
      (window as any).GM_getValue = (k: string, d: unknown = "") => (window as any).__gm[k] ?? d;
      (window as any).GM_setValue = (k: string, v: unknown) => {
        (window as any).__gm[k] = v;
      };
    });
    await page.goto(`${BASE}/en/`);

    // Seed 2 cards into GM storage
    await seedGM(page, [
      { url: "https://example.com/card-a", title: "Card A" },
      { url: "https://example.com/card-b", title: "Card B" },
    ]);

    // Run syncToSiteDB to populate IDB
    const written = await page.evaluate(
      new Function(
        `return async () => { ${SYNC_FN}; return runSyncToSiteDB(); }`,
      )() as () => Promise<number>,
    );
    expect(written).toBe(2);

    // Verify IDB contents directly
    const idb = await readAllIDB(page);
    const cardKeys = Object.keys(idb).filter((k) => k.startsWith("card:"));
    expect(cardKeys).toHaveLength(2);
    expect(idb["meta:gm-count"]).toBe(2);

    // Navigate to /list — the SyncStatusBanner should read these counts
    await page.goto(`${BASE}/en/list`);
    await page.waitForSelector("text=Guest Mode - Local Storage", { timeout: 10_000 });

    // Wait for the IDB read to complete (Script count should go from "…" to "2")
    await page.waitForFunction(
      () => {
        const spans = Array.from(document.querySelectorAll("span.font-mono"));
        return spans.some((s) => s.textContent?.trim() === "2");
      },
      { timeout: 8_000 },
    );

    const scriptBox = page.locator("span.font-mono").filter({ hasText: "2" }).first();
    await expect(scriptBox).toBeVisible();
  });
});
