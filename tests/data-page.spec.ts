/**
 * /data — the data-management page, as a signed-out visitor.
 *
 * Guests are the interesting case: the page has to work with no session at all,
 * reading the Local store (the `lianki-keyval` IndexedDB mirror the userscript
 * writes) entirely client-side, while every cloud affordance stays inert. The
 * signed-in cloud table is covered by the API checks in `scripts/qa/qa-api.mjs`,
 * which drive the same endpoints this page calls.
 *
 * Also covers the app shell: the left sidebar replaced 16 copy-pasted <Header>
 * blocks, so a page silently losing its navigation is the regression to catch.
 */

import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.LIANKI_URL || "https://lianki.com";

type SeedCard = {
  url: string;
  title: string;
  card: Record<string, unknown>;
  synced?: boolean;
};

function card(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    due: new Date(Date.now() + 86_400_000).toISOString(),
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    ...overrides,
  };
}

/**
 * The title cell for a row.
 *
 * Anchored, because the row's checkbox cell is labelled "Select <title>" and an
 * unanchored name match would resolve to both cells.
 */
function titleCell(page: Page, title: string) {
  return page.getByRole("cell", {
    name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
}

/** Write cards into `lianki-keyval` exactly as the userscript's syncToSiteDB does. */
async function seedLocalStore(page: Page, cards: SeedCard[]) {
  await page.evaluate((cards: SeedCard[]) => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("lianki-keyval", 1);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains("keyval")) db.createObjectStore("keyval");
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("keyval", "readwrite");
        const store = tx.objectStore("keyval");
        for (const c of cards) store.put({ ...c, log: [] }, `card:${c.url}`);
        store.put(cards.length, "meta:gm-count");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, cards);
}

async function gotoSeeded(page: Page, cards: SeedCard[]) {
  // Seed on the target origin first, then reload so the page reads it on mount.
  await page.goto(`${BASE}/data`);
  await seedLocalStore(page, cards);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Cards", level: 2 })).toBeVisible();
}

const THREE: SeedCard[] = [
  { url: "https://a.test/genki", title: "Genki Lesson 3", card: card({ state: 2, reps: 7 }) },
  { url: "https://b.test/kanji", title: "Kanji drill", card: card({ state: 0 }) },
  {
    url: "https://c.test/overdue",
    title: "Overdue item",
    card: card({ due: new Date(Date.now() - 86_400_000).toISOString(), state: 2 }),
    synced: false,
  },
];

test.describe("/data as a guest", () => {
  test("renders without a session", async ({ page }) => {
    const res = await page.goto(`${BASE}/data`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Data", level: 1 })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("shows all three storage panels", async ({ page }) => {
    await page.goto(`${BASE}/data`);
    const stores = page.getByRole("region", { name: "Storage" });
    for (const name of ["Script", "Local", "Cloud"]) {
      await expect(stores.getByRole("heading", { name, level: 3 })).toBeVisible();
    }
  });

  test("lists the cards mirrored into this browser", async ({ page }) => {
    await gotoSeeded(page, THREE);
    for (const c of THREE) {
      await expect(titleCell(page, c.title)).toBeVisible();
    }
  });

  test("search narrows the local table", async ({ page }) => {
    await gotoSeeded(page, THREE);
    await page.getByLabel("Search cards").fill("genki");
    await expect(titleCell(page, "Genki Lesson 3")).toBeVisible();
    await expect(titleCell(page, "Kanji drill")).toHaveCount(0);
  });

  test("'Due only' hides cards that are not yet due", async ({ page }) => {
    await gotoSeeded(page, THREE);
    await page.getByLabel("Due only").check();
    await expect(titleCell(page, "Overdue item")).toBeVisible();
    await expect(titleCell(page, "Kanji drill")).toHaveCount(0);
  });

  test("state filter selects one FSRS state", async ({ page }) => {
    await gotoSeeded(page, THREE);
    await page.getByLabel("Filter by state").selectOption("0");
    await expect(titleCell(page, "Kanji drill")).toBeVisible();
    await expect(titleCell(page, "Genki Lesson 3")).toHaveCount(0);
  });

  test("selected local cards can be deleted, and stay deleted", async ({ page }) => {
    await gotoSeeded(page, THREE);
    page.on("dialog", (d) => d.accept());

    await page.getByLabel("Select Genki Lesson 3").check();
    await page.getByRole("button", { name: /Delete selected \(1\)/ }).click();

    await expect(titleCell(page, "Genki Lesson 3")).toHaveCount(0);
    await page.reload();
    await expect(titleCell(page, "Kanji drill")).toBeVisible();
    await expect(titleCell(page, "Genki Lesson 3")).toHaveCount(0);
  });

  test("cloud affordances are inert without a session", async ({ page }) => {
    await gotoSeeded(page, THREE);

    // Push needs an account to push into.
    await expect(page.getByRole("button", { name: /Push local cards to cloud/ })).toBeDisabled();
    // The Cloud store cannot be selected at all.
    await expect(page.locator('#store-select option[value="cloud"]')).toBeDisabled();
    // And the cloud-only export is absent.
    await expect(page.getByRole("link", { name: /Export YAML — cloud/ })).toHaveCount(0);
  });

  test("a local YAML backup can be exported", async ({ page }) => {
    await gotoSeeded(page, THREE);
    const button = page.getByRole("button", { name: /Export YAML — local \(3\)/ });
    await expect(button).toBeEnabled();

    const download = await Promise.all([page.waitForEvent("download"), button.click()]).then(
      ([d]) => d,
    );
    expect(download.suggestedFilename()).toMatch(/^lianki-local-export-\d{4}-\d{2}-\d{2}\.yaml$/);
  });

  test("destructive actions stay locked until DELETE is typed", async ({ page }) => {
    await gotoSeeded(page, THREE);
    const wipe = page.getByRole("button", { name: /Wipe this browser/ });

    await expect(wipe).toBeDisabled();
    await page.getByLabel(/Type DELETE/).fill("delete"); // wrong case must not arm it
    await expect(wipe).toBeDisabled();

    await page.getByLabel(/Type DELETE/).fill("DELETE");
    await expect(wipe).toBeEnabled();
    await wipe.click();

    await expect(page.getByText(/Removed 3 cards from this browser/)).toBeVisible();
    await expect(titleCell(page, "Kanji drill")).toHaveCount(0);
  });
});

test.describe("app shell", () => {
  // The sidebar replaced a per-page <Header>; a page that lost its nav in that
  // sweep would still render fine on its own, so assert the shell explicitly.
  const ROUTES = ["/data", "/list", "/import", "/learn", "/read", "/add-note", "/ai-vocab"];

  for (const route of ROUTES) {
    test(`${route} renders the sidebar with a link to every feature`, async ({ page }) => {
      await page.goto(`${BASE}${route}`);
      const nav = page.getByRole("navigation", { name: "Menu" }).first();

      await expect(nav.getByRole("link", { name: "Cards" })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Data" })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Import" })).toBeVisible();
      // Exactly one <main> landmark: the shell owns it now.
      await expect(page.locator("main")).toHaveCount(1);
    });
  }

  test("the active route is marked for assistive tech", async ({ page }) => {
    await page.goto(`${BASE}/data`);
    const current = page.locator('nav a[aria-current="page"]').first();
    await expect(current).toHaveText("💾Data");
  });

  test("the collapsed sidebar survives a reload", async ({ page }) => {
    await page.goto(`${BASE}/data`);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  });
});
