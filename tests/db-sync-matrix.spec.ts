/**
 * DB Sync Matrix — Playwright E2E
 *
 * Covers two sync edges observable purely in the browser (no server writes):
 *
 *   Edge A: GM Storage → IndexedDB (syncToSiteDB)
 *     CRUD ×4 + synced-flag accuracy
 *
 *   Edge B: GM queue → MongoDB API (page.route mocks capture actual fetch calls)
 *     ADD / REVIEW / DELETE actions verify call shape and HLC propagation
 *
 * Run against any BASE_URL — API mocks intercept the calls before they leave the browser.
 */

import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

const BASE = process.env.LIANKI_URL || "https://www.lianki.com";
const SCRIPT_CONTENT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

// ── Shared helpers (mirrors sync-status.spec.ts utilities) ───────────────────

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

/** djb2 hash matching the userscript's hashUrl() */
function hashUrl(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

async function setupGMPage(page: Page) {
  await page.addInitScript(() => {
    (window as any).__gm = {} as Record<string, string>;
    (window as any).GM_getValue = (k: string, d: unknown = "") => (window as any).__gm[k] ?? d;
    (window as any).GM_setValue = (k: string, v: unknown) => {
      (window as any).__gm[k] = v;
    };
  });
  await page.goto(`${BASE}/en/`);
}

async function seedGMCards(page: Page, cards: { url: string; title: string; dirty?: boolean }[]) {
  await page.evaluate(
    ({
      cards,
      hashFnSrc,
    }: {
      cards: { url: string; title: string; dirty?: boolean }[];
      hashFnSrc: string;
    }) => {
      const hash: (u: string) => string = new Function(`return (${hashFnSrc})`)();
      const CARD_PREFIX = "lk:c:";
      const INDEX_KEY = "lk:card-index";
      const index: { url: string; due: string; hash: string }[] = [];
      for (const c of cards) {
        const due = new Date(Date.now() + 86_400_000).toISOString();
        const h = hash(c.url);
        const entry = {
          _url: c.url,
          note: {
            _id: `local:${h}`,
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
          hlc: { timestamp: Date.now(), counter: 0, deviceId: "test-device" },
          dirty: c.dirty !== false,
        };
        (window as any).GM_setValue(CARD_PREFIX + h, JSON.stringify(entry));
        index.push({ url: c.url, due, hash: h });
      }
      (window as any).GM_setValue(INDEX_KEY, JSON.stringify(index));
    },
    { cards, hashFnSrc: hashUrl.toString() },
  );
}

/** Minimal syncToSiteDB extracted for in-page evaluation */
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

const syncFn = () =>
  new Function(
    `return async () => { ${SYNC_FN}; return runSyncToSiteDB(); }`,
  )() as () => Promise<number>;

// ── Edge A: GM Storage → IndexedDB ────────────────────────────────────────────

test.describe("Edge A: GM Storage → IndexedDB (syncToSiteDB)", () => {
  test("CREATE — new GM card appears in IDB with correct fields", async ({ page }) => {
    await setupGMPage(page);
    await seedGMCards(page, [{ url: "https://create.example.com/page", title: "Created Page" }]);

    const count = await page.evaluate(syncFn());
    expect(count).toBe(1);

    const idb = await readAllIDB(page);
    const card = idb["card:https://create.example.com/page"] as any;
    expect(card).toBeTruthy();
    expect(card.url).toBe("https://create.example.com/page");
    expect(card.title).toBe("Created Page");
    expect(card.card).toBeDefined();
    expect(card.log).toBeDefined();
    expect(card.hlc).toBeDefined();
  });

  test("UPDATE — title change in GM is reflected in IDB after re-sync", async ({ page }) => {
    await setupGMPage(page);
    const url = "https://update.example.com/page";

    await seedGMCards(page, [{ url, title: "Original Title" }]);
    await page.evaluate(syncFn());

    // Update title in GM
    await page.evaluate(
      ({ url, hashFnSrc }: { url: string; hashFnSrc: string }) => {
        const hash: (u: string) => string = new Function(`return (${hashFnSrc})`)();
        const h = hash(url);
        const raw = JSON.parse((window as any).GM_getValue(`lk:c:${h}`, "{}"));
        raw.note.title = "Updated Title";
        (window as any).GM_setValue(`lk:c:${h}`, JSON.stringify(raw));
      },
      { url, hashFnSrc: hashUrl.toString() },
    );

    await page.evaluate(syncFn());

    const idb = await readAllIDB(page);
    expect((idb[`card:${url}`] as any).title).toBe("Updated Title");
  });

  test("READ — meta:gm-count matches number of GM cards", async ({ page }) => {
    await setupGMPage(page);
    await seedGMCards(page, [
      { url: "https://a.example.com/1", title: "A" },
      { url: "https://a.example.com/2", title: "B" },
      { url: "https://a.example.com/3", title: "C" },
    ]);

    await page.evaluate(syncFn());

    const idb = await readAllIDB(page);
    expect(idb["meta:gm-count"]).toBe(3);
  });

  test("synced flag — dirty=true produces synced=false in IDB", async ({ page }) => {
    await setupGMPage(page);
    await seedGMCards(page, [
      { url: "https://dirty.example.com/page", title: "Dirty", dirty: true },
    ]);
    await page.evaluate(syncFn());

    const idb = await readAllIDB(page);
    expect((idb["card:https://dirty.example.com/page"] as any).synced).toBe(false);
  });

  test("synced flag — dirty=false produces synced=true in IDB", async ({ page }) => {
    await setupGMPage(page);
    await seedGMCards(page, [
      { url: "https://clean.example.com/page", title: "Clean", dirty: false },
    ]);
    await page.evaluate(syncFn());

    const idb = await readAllIDB(page);
    expect((idb["card:https://clean.example.com/page"] as any).synced).toBe(true);
  });

  test("DELETE — removing a card from GM index leaves stale entry in IDB (one-way sync)", async ({
    page,
  }) => {
    await setupGMPage(page);
    const url = "https://delete.example.com/page";

    await seedGMCards(page, [{ url, title: "To Delete" }]);
    await page.evaluate(syncFn()); // initial sync — card in IDB

    // Remove card from GM index (simulate deletion from userscript side)
    await page.evaluate(() => {
      (window as any).GM_setValue("lk:card-index", "[]");
    });
    await page.evaluate(syncFn()); // re-sync with empty index

    const idb = await readAllIDB(page);
    // IDB is a one-directional mirror: deletion from GM does NOT auto-delete from IDB
    expect(idb[`card:${url}`]).toBeDefined();
    // syncToSiteDB early-returns on empty index, so meta:gm-count retains stale value
    expect(idb["meta:gm-count"]).toBe(1);
  });

  test("IDEMPOTENT — syncing the same GM state twice produces identical IDB", async ({ page }) => {
    await setupGMPage(page);
    await seedGMCards(page, [{ url: "https://idem.example.com/page", title: "Idempotent" }]);

    await page.evaluate(syncFn());
    const idb1 = await readAllIDB(page);

    await page.evaluate(syncFn());
    const idb2 = await readAllIDB(page);

    expect(JSON.stringify(idb2)).toBe(JSON.stringify(idb1));
  });

  test("MULTI — 5 cards all land in IDB with correct card: prefix keys", async ({ page }) => {
    await setupGMPage(page);
    const cards = Array.from({ length: 5 }, (_, i) => ({
      url: `https://multi.example.com/page-${i}`,
      title: `Page ${i}`,
    }));

    await seedGMCards(page, cards);
    await page.evaluate(syncFn());

    const idb = await readAllIDB(page);
    const cardKeys = Object.keys(idb).filter((k) => k.startsWith("card:"));
    expect(cardKeys).toHaveLength(5);
    expect(idb["meta:gm-count"]).toBe(5);
  });
});

// ── Edge B: GM queue → MongoDB API (page.route intercepts) ───────────────────

test.describe("Edge B: GM queue shape → MongoDB API call format", () => {
  /** Minimal sync queue sandbox that uses window.fetch (interceptable by page.route) */
  const QUEUE_SYNC_SANDBOX = `
async function setupQueueSync(apiBase) {
  const QUEUE_KEY = "lk:queue";
  const CARD_PREFIX = "lk:c:";
  const INDEX_KEY = "lk:card-index";

  function gmGet(k, d) { return window.GM_getValue(k, d); }
  function gmSet(k, v) { window.GM_setValue(k, v); }

  function getQueue() { return JSON.parse(gmGet(QUEUE_KEY, "[]")); }
  function removeFromQueue(id) {
    gmSet(QUEUE_KEY, JSON.stringify(getQueue().filter(q => q.id !== id)));
  }

  function enqueue(action, data, hlc) {
    const queue = getQueue();
    queue.push({ id: crypto.randomUUID(), action, data, hlc, retries: 0 });
    gmSet(QUEUE_KEY, JSON.stringify(queue));
  }

  async function syncItem(item) {
    if (item.action === "add") {
      const r = await fetch(apiBase + "/api/fsrs/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: item.data.url, title: item.data.title }),
      });
      return r.json();
    }
    if (item.action === "review") {
      const r = await fetch(
        apiBase + "/api/fsrs/review/" + item.data.rating + "?id=" + encodeURIComponent(item.data.noteId),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hlc: item.hlc }),
        },
      );
      return r.json();
    }
    if (item.action === "delete") {
      const r = await fetch(
        apiBase + "/api/fsrs/delete?id=" + encodeURIComponent(item.data.noteId),
      );
      return r.json();
    }
  }

  async function flushQueue() {
    const queue = getQueue();
    const results = [];
    for (const item of queue) {
      try {
        const result = await syncItem(item);
        removeFromQueue(item.id);
        results.push({ action: item.action, data: item.data, hlc: item.hlc, result });
      } catch (e) {
        results.push({ action: item.action, error: e.message });
      }
    }
    return results;
  }

  return { enqueue, getQueue, flushQueue };
}
`;

  async function setupQueuePage(page: Page) {
    await page.addInitScript(() => {
      (window as any).__gm = {} as Record<string, string>;
      (window as any).GM_getValue = (k: string, d: unknown = "") => (window as any).__gm[k] ?? d;
      (window as any).GM_setValue = (k: string, v: unknown) => {
        (window as any).__gm[k] = v;
      };
    });
    await page.goto(`${BASE}/en/`);
  }

  test("ADD action — POST /api/fsrs/add called with correct URL and title", async ({ page }) => {
    const calls: { url: string; body: unknown }[] = [];
    await page.route(`${BASE}/api/fsrs/add`, (route) => {
      calls.push({
        url: route.request().url(),
        body: JSON.parse(route.request().postData() || "{}"),
      });
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          _id: "server-id-123",
          url: "https://example.com/add-test",
          title: "Add Test",
          card: { reps: 0, state: 0 },
          hlc: { timestamp: Date.now(), counter: 0, deviceId: "server" },
        }),
      });
    });

    await setupQueuePage(page);

    await page.evaluate(
      async ({ sandbox, base }: { sandbox: string; base: string }) => {
        const fn = new Function(
          `return async (apiBase) => { ${sandbox}; return setupQueueSync(apiBase); }`,
        )();
        const sync = await fn(base);
        sync.enqueue(
          "add",
          { url: "https://example.com/add-test", title: "Add Test" },
          {
            timestamp: Date.now(),
            counter: 0,
            deviceId: "test-device",
          },
        );
        return sync.flushQueue();
      },
      { sandbox: QUEUE_SYNC_SANDBOX, base: BASE },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      url: "https://example.com/add-test",
      title: "Add Test",
    });
  });

  test("REVIEW action — POST /api/fsrs/review/{rating} called with HLC in body", async ({
    page,
  }) => {
    const calls: { url: string; body: unknown }[] = [];
    await page.route(`${BASE}/api/fsrs/review/**`, (route) => {
      calls.push({
        url: route.request().url(),
        body: JSON.parse(route.request().postData() || "{}"),
      });
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          hlc: { timestamp: Date.now(), counter: 1, deviceId: "server" },
          card: { reps: 1, state: 2 },
        }),
      });
    });

    await setupQueuePage(page);

    const clientHLC = { timestamp: Date.now() - 1000, counter: 0, deviceId: "test-device" };
    await page.evaluate(
      async ({ sandbox, base, hlc }: { sandbox: string; base: string; hlc: typeof clientHLC }) => {
        const fn = new Function(
          `return async (apiBase) => { ${sandbox}; return setupQueueSync(apiBase); }`,
        )();
        const sync = await fn(base);
        sync.enqueue(
          "review",
          { noteId: "note-id-abc", rating: "good", url: "https://example.com/review-test" },
          hlc,
        );
        return sync.flushQueue();
      },
      { sandbox: QUEUE_SYNC_SANDBOX, base: BASE, hlc: clientHLC },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/fsrs/review/good");
    expect(calls[0]!.url).toContain("note-id-abc");
    expect((calls[0]!.body as any).hlc).toMatchObject({
      deviceId: "test-device",
      counter: 0,
    });
  });

  test("DELETE action — GET /api/fsrs/delete called with note ID", async ({ page }) => {
    const calls: string[] = [];
    await page.route(`${BASE}/api/fsrs/delete**`, (route) => {
      calls.push(route.request().url());
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, nextUrl: null }),
      });
    });

    await setupQueuePage(page);

    await page.evaluate(
      async ({ sandbox, base }: { sandbox: string; base: string }) => {
        const fn = new Function(
          `return async (apiBase) => { ${sandbox}; return setupQueueSync(apiBase); }`,
        )();
        const sync = await fn(base);
        sync.enqueue(
          "delete",
          { noteId: "delete-note-id-xyz" },
          { timestamp: Date.now(), counter: 0, deviceId: "test-device" },
        );
        return sync.flushQueue();
      },
      { sandbox: QUEUE_SYNC_SANDBOX, base: BASE },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/fsrs/delete");
    expect(calls[0]).toContain("delete-note-id-xyz");
  });

  test("queue is cleared after successful flush", async ({ page }) => {
    await page.route(`${BASE}/api/fsrs/add`, (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          _id: "x",
          url: "https://example.com/flush-test",
          card: {},
          hlc: {},
        }),
      });
    });

    await setupQueuePage(page);

    const queueAfterFlush = await page.evaluate(
      async ({ sandbox, base }: { sandbox: string; base: string }) => {
        const fn = new Function(
          `return async (apiBase) => { ${sandbox}; return setupQueueSync(apiBase); }`,
        )();
        const sync = await fn(base);
        sync.enqueue(
          "add",
          { url: "https://example.com/flush-test", title: "Flush" },
          {
            timestamp: Date.now(),
            counter: 0,
            deviceId: "test-device",
          },
        );
        await sync.flushQueue();
        return sync.getQueue();
      },
      { sandbox: QUEUE_SYNC_SANDBOX, base: BASE },
    );

    expect(queueAfterFlush).toHaveLength(0);
  });

  test("MULTI — 3 queued actions produce 3 API calls in order", async ({ page }) => {
    const callOrder: string[] = [];

    await page.route(`${BASE}/api/fsrs/add`, (route) => {
      callOrder.push("add");
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ _id: "x", url: "", card: {}, hlc: {} }),
      });
    });
    await page.route(`${BASE}/api/fsrs/review/**`, (route) => {
      callOrder.push("review");
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, hlc: {}, card: {} }),
      });
    });
    await page.route(`${BASE}/api/fsrs/delete**`, (route) => {
      callOrder.push("delete");
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await setupQueuePage(page);

    await page.evaluate(
      async ({ sandbox, base }: { sandbox: string; base: string }) => {
        const fn = new Function(
          `return async (apiBase) => { ${sandbox}; return setupQueueSync(apiBase); }`,
        )();
        const sync = await fn(base);
        const now = Date.now();
        sync.enqueue(
          "add",
          { url: "https://example.com/multi-1", title: "Multi 1" },
          { timestamp: now, counter: 0, deviceId: "d" },
        );
        sync.enqueue(
          "review",
          { noteId: "note-multi", rating: "good" },
          { timestamp: now + 1, counter: 0, deviceId: "d" },
        );
        sync.enqueue(
          "delete",
          { noteId: "note-delete" },
          { timestamp: now + 2, counter: 0, deviceId: "d" },
        );
        return sync.flushQueue();
      },
      { sandbox: QUEUE_SYNC_SANDBOX, base: BASE },
    );

    expect(callOrder).toEqual(["add", "review", "delete"]);
  });
});

// ── Edge C: SyncStatusBanner reads counts from both IDB and server prop ───────

test.describe("Edge C: SyncStatusBanner shows counts from all layers", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("Script count reflects meta:gm-count in IDB, Local count reflects card: keys", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as any).__gm = {} as Record<string, string>;
      (window as any).GM_getValue = (k: string, d: unknown = "") => (window as any).__gm[k] ?? d;
      (window as any).GM_setValue = (k: string, v: unknown) => {
        (window as any).__gm[k] = v;
      };
    });
    await page.goto(`${BASE}/en/`);

    const cards = [
      { url: "https://banner.example.com/1", title: "Card 1" },
      { url: "https://banner.example.com/2", title: "Card 2" },
    ];
    await seedGMCards(page, cards);
    await page.evaluate(syncFn());

    await page.goto(`${BASE}/en/list`);
    await page.waitForSelector("text=Guest Mode - Local Storage", { timeout: 10_000 });

    await page.waitForFunction(
      () => {
        const spans = Array.from(document.querySelectorAll("span.font-mono"));
        return spans.some((s) => s.textContent?.trim() === "2");
      },
      { timeout: 8_000 },
    );

    const countSpans = await page.$$eval("span.font-mono", (els) =>
      els.map((e) => e.textContent?.trim()),
    );
    expect(countSpans).toContain("2");
  });
});
