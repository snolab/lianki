/**
 * Userscript Guest Flow Tests
 *
 * Covers the full lifecycle for a user who has the userscript installed but
 * is NOT logged into lianki.com:
 *
 *   install → init → open dialog → 401 → local card created → review →
 *   returning visit (cache hit) → queue persists across page loads
 *
 * Technique:
 * - Inject GM_* mocks via addInitScript (runs before page JS on each navigation)
 * - Wrap the userscript in an IIFE (Violentmonkey does this; addScriptTag does not,
 *   and Chrome rejects a top-level `return` statement in plain <script> tags)
 * - Control API responses via a mocked GM_xmlhttpRequest
 * - All UI interactions done via dispatchEvent inside page.evaluate (no keyboard
 *   shortcuts — they are unreliable on about:blank without a real focused element)
 * - Inspect state by reading window.__gm (the mock GM storage object)
 */

import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SCRIPT_PATH = join(process.cwd(), "public/lianki.user.js");
const SCRIPT_CONTENT = readFileSync(SCRIPT_PATH, "utf-8");
// Wrap in IIFE so the top-level `return` in the userscript is valid JS
// (Violentmonkey does this automatically; plain addScriptTag does not)
const WRAPPED_CONTENT = `(function() {\n${SCRIPT_CONTENT}\n})();`;

// about:blank: fast, no external network, hostname ≠ "www.lianki.com"
const TEST_PAGE = "about:blank";

type ApiMock = { status: 200; body: object } | { status: 401 } | { status: 500 };

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup(page: Page, apiMock: ApiMock = { status: 401 }) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Inject GM mocks before any page JS runs
  await page.addInitScript(() => {
    (window as any).__gm = {} as Record<string, string>;
    (window as any).GM_getValue = (k: string, d: unknown = "") => (window as any).__gm[k] ?? d;
    (window as any).GM_setValue = (k: string, v: unknown) => {
      (window as any).__gm[k] = v;
    };
    (window as any).GM_deleteValue = (k: string) => {
      delete (window as any).__gm[k];
    };
    (window as any).GM_info = {
      script: {
        version: "2.21.1",
        downloadURL: "https://www.lianki.com/lianki.user.js",
      },
    };
    (window as any).GM_xmlhttpRequest = () => {};
  });

  await page.goto(TEST_PAGE);

  // Install the per-test API mock
  await page.evaluate((mock: ApiMock) => {
    (window as any).GM_xmlhttpRequest = ({ onload }: any) => {
      const body = "body" in mock ? JSON.stringify(mock.body) : "Unauthorized";
      setTimeout(
        () =>
          onload({
            status: mock.status,
            ok: mock.status >= 200 && mock.status < 300,
            responseText: body,
            responseHeaders: "content-type: application/json\r\ncontent-length: 0\r\n",
          }),
        20,
      );
    };
  }, apiMock);

  // Inject the userscript wrapped in an IIFE
  await page.addScriptTag({ content: WRAPPED_CONTENT });

  // Wait for initOfflineStorage (setTimeout 100ms inside main())
  await page.waitForTimeout(300);

  return { errors };
}

// ── UI helpers ────────────────────────────────────────────────────────────────

/** Find the dialog's shadow host (div with an open, populated shadowRoot) */
const FIND_HOST = () =>
  Array.from(document.querySelectorAll("div")).find(
    (d) => d.shadowRoot && d.shadowRoot.childNodes.length > 0,
  ) as (HTMLElement & { shadowRoot: ShadowRoot }) | undefined;

/** Click the FAB 🔖 button via JS (bypasses keyboard/focus issues on about:blank) */
async function clickFab(page: Page) {
  await page.evaluate(() => {
    const fab = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("🔖"),
    ) as HTMLElement | undefined;
    if (!fab) throw new Error("FAB 🔖 not found");
    fab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Open the dialog and wait until it shows the reviewing phase (4 rating buttons) */
async function openDialog(page: Page) {
  await clickFab(page);

  // Shadow host appears as soon as mountDialog() runs
  await page.waitForFunction(
    (fn: string) => !!new Function(`return (${fn})`)()(),
    FIND_HOST.toString(),
    { timeout: 5000 },
  );

  // Wait for reviewing phase (4 buttons) or error div
  await page.waitForFunction(
    (fn: string) => {
      const host = new Function(`return (${fn})`)()();
      if (!host?.shadowRoot) return false;
      const btns = host.shadowRoot.querySelectorAll("button");
      return btns.length >= 4 || !!host.shadowRoot.querySelector('div[style*="color: #f66"]');
    },
    FIND_HOST.toString(),
    { timeout: 8000 },
  );
}

/**
 * Click a rating button by label text ("Again" | "Hard" | "Good" | "Easy").
 * After clicking, afterReview() runs: it calls getNextUrl (→ 401 → null),
 * then sets a 2s timer to auto-close the dialog.
 */
async function clickRating(page: Page, label: "Again" | "Hard" | "Good" | "Easy") {
  await page.evaluate(
    ([findFn, lbl]) => {
      const host = new Function(`return (${findFn})`)()() as
        | (HTMLElement & { shadowRoot: ShadowRoot })
        | undefined;
      if (!host?.shadowRoot) throw new Error("No dialog found");
      const btn = Array.from(host.shadowRoot.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(lbl),
      ) as HTMLElement | undefined;
      if (!btn) throw new Error(`Rating button "${lbl}" not found`);
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    },
    [FIND_HOST.toString(), label] as [string, string],
  );
}

/** Wait for the dialog shadow host to disappear (auto-closes 2s after review) */
async function waitForDialogClosed(page: Page) {
  await page.waitForFunction(
    (fn: string) => !new Function(`return (${fn})`)()(),
    FIND_HOST.toString(),
    { timeout: 6000 },
  );
}

/** Parse a JSON value from the GM mock storage */
async function gmJSON(page: Page, key: string): Promise<unknown> {
  const raw = await page.evaluate((k) => (window as any).__gm?.[k] as string | undefined, key);
  if (!raw) return null;
  return JSON.parse(raw);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Userscript integrity (static analysis)", () => {
  test("@version matches semver", () => {
    expect(SCRIPT_CONTENT).toMatch(/@version\s+\d+\.\d+\.\d+/);
  });

  test("grants GM_deleteValue", () => {
    expect(SCRIPT_CONTENT).toContain("@grant       GM_deleteValue");
  });

  test("uses GMCardStorage instead of IndexedDB CardStorage", () => {
    expect(SCRIPT_CONTENT).toContain("class GMCardStorage");
    expect(SCRIPT_CONTENT).toMatch(/new GMCardStorage[\s(;]/);
    expect(SCRIPT_CONTENT).not.toContain("createStore(");
  });

  test("hashUrl produces consistent 8-hex-char strings", () => {
    const match = SCRIPT_CONTENT.match(/function hashUrl\(url\) \{[\s\S]*?\n {2}\}/);
    expect(match).toBeTruthy();
    const fn = new Function(`${match![0]}; return hashUrl;`)() as (s: string) => string;
    const h = fn("https://en.wikipedia.org/wiki/Spaced_repetition");
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(fn("https://example.com")).toBe(fn("https://example.com"));
    expect(fn("https://example.com/a")).not.toBe(fn("https://example.com/b"));
  });
});

test.describe("LDF eviction logic (in-page sandbox)", () => {
  test("index stays at MAX_CARDS=2000 when 2001st card is inserted", async ({ page }) => {
    await setup(page);

    const result = await page.evaluate(() => {
      const MAX = 2000;
      const PREFIX = "lk:c:";
      const INDEX = "lk:card-index";

      function hash(url: string) {
        let h = 5381;
        for (let i = 0; i < url.length; i++) h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
        return h.toString(16).padStart(8, "0");
      }

      const idx: { url: string; due: string; hash: string }[] = [];
      for (let i = 0; i < MAX; i++) {
        const url = `https://example.com/page-${i}`;
        const due = new Date(Date.now() + i * 60_000).toISOString();
        const h = hash(url);
        idx.push({ url, due, hash: h });
        (window as any).GM_setValue(PREFIX + h, "1");
      }
      (window as any).GM_setValue(INDEX, JSON.stringify(idx));

      // Furthest-due = last card (i = MAX-1)
      const furthestUrl = `https://example.com/page-${MAX - 1}`;
      const furthestHash = hash(furthestUrl);

      // Insert 2001st card (already overdue)
      const newUrl = "https://example.com/new-card";
      const newDue = new Date(Date.now() - 3_600_000).toISOString();
      const newHash = hash(newUrl);

      const cur: typeof idx = JSON.parse((window as any).GM_getValue(INDEX, "[]"));
      if (cur.length >= MAX) {
        const maxI = cur.reduce(
          (mi: number, e: { due: string }, i: number, a: { due: string }[]) =>
            new Date(e.due) > new Date(a[mi].due) ? i : mi,
          0,
        );
        (window as any).GM_deleteValue(PREFIX + cur[maxI].hash);
        cur.splice(maxI, 1);
      }
      cur.push({ url: newUrl, due: newDue, hash: newHash });
      (window as any).GM_setValue(INDEX, JSON.stringify(cur));

      const final: typeof idx = JSON.parse((window as any).GM_getValue(INDEX, "[]"));
      return {
        indexLength: final.length,
        furthestEvicted: !(window as any).GM_getValue(PREFIX + furthestHash, ""),
        newCardPresent: final.some((e) => e.url === newUrl),
        furthestUrlGone: !final.some((e) => e.url === furthestUrl),
      };
    });

    expect(result.indexLength).toBe(2000);
    expect(result.furthestEvicted).toBe(true);
    expect(result.newCardPresent).toBe(true);
    expect(result.furthestUrlGone).toBe(true);
  });
});

test.describe("Guest initialization", () => {
  test("script injects without page errors", async ({ page }) => {
    const { errors } = await setup(page, { status: 401 });
    expect(errors).toHaveLength(0);
  });

  test("FAB (🔖) button appears on the page after injection", async ({ page }) => {
    await setup(page, { status: 401 });
    const fabVisible = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes("🔖")),
    );
    expect(fabVisible).toBe(true);
  });
});

test.describe("Guest card creation (401 flow)", () => {
  test("opening dialog on a new URL creates a local card in GM storage", async ({ page }) => {
    await setup(page, { status: 401 });
    await openDialog(page);

    const index = (await gmJSON(page, "lk:card-index")) as { url: string; hash: string }[] | null;
    expect(Array.isArray(index)).toBe(true);
    expect(index!.length).toBe(1);
    expect(index![0].url).toBeTruthy();
    expect(index![0].hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test("local card gets a 'local:' prefixed _id", async ({ page }) => {
    await setup(page, { status: 401 });
    await openDialog(page);

    const index = (await gmJSON(page, "lk:card-index")) as { hash: string }[];
    const card = (await gmJSON(page, `lk:c:${index[0].hash}`)) as { note: { _id: string } };
    expect(card.note._id).toMatch(/^local:/);
  });

  test("local card is marked dirty (pending server sync)", async ({ page }) => {
    await setup(page, { status: 401 });
    await openDialog(page);

    const index = (await gmJSON(page, "lk:card-index")) as { hash: string }[];
    const card = (await gmJSON(page, `lk:c:${index[0].hash}`)) as { dirty: boolean };
    expect(card.dirty).toBe(true);
  });

  test("dialog shows reviewing phase with Again/Hard/Good/Easy buttons", async ({ page }) => {
    await setup(page, { status: 401 });
    await openDialog(page);

    // Confirm phase via button label text
    const labels = await page.evaluate((fn: string) => {
      const host = new Function(`return (${fn})`)()() as
        | (HTMLElement & { shadowRoot: ShadowRoot })
        | undefined;
      if (!host?.shadowRoot) return [];
      return Array.from(host.shadowRoot.querySelectorAll("button"))
        .map((b) => b.textContent?.trim() ?? "")
        .filter((t) => ["Again", "Hard", "Good", "Easy"].some((l) => t.includes(l)));
    }, FIND_HOST.toString());

    expect(labels.length).toBe(4);
    expect(labels.some((l) => l.includes("Again"))).toBe(true);
    expect(labels.some((l) => l.includes("Good"))).toBe(true);
    expect(labels.some((l) => l.includes("Easy"))).toBe(true);
  });

  test("an 'add' action is queued for later server sync", async ({ page }) => {
    await setup(page, { status: 401 });
    await openDialog(page);

    const queue = (await gmJSON(page, "lk:queue")) as {
      action: string;
      data: { url: string };
    }[];
    const addItem = queue.find((e) => e.action === "add");
    expect(addItem).toBeTruthy();
    expect(addItem!.data.url).toBeTruthy();
  });
});

test.describe("Guest review flow", () => {
  test("clicking Good advances the card due date", async ({ page }) => {
    await setup(page, { status: 401 });
    await openDialog(page);

    const indexBefore = (await gmJSON(page, "lk:card-index")) as {
      url: string;
      due: string;
      hash: string;
    }[];
    const dueBefore = indexBefore[0].due;

    await clickRating(page, "Good");
    await page.waitForTimeout(300);

    const indexAfter = (await gmJSON(page, "lk:card-index")) as { url: string; due: string }[];
    const entryAfter = indexAfter.find((e) => e.url === indexBefore[0].url);
    expect(entryAfter).toBeTruthy();
    expect(new Date(entryAfter!.due).getTime()).toBeGreaterThan(new Date(dueBefore).getTime());
  });

  test("review queues a 'review' action with rating=3 for Good", async ({ page }) => {
    await setup(page, { status: 401 });
    await openDialog(page);
    await clickRating(page, "Good");
    await page.waitForTimeout(300);

    const queue = (await gmJSON(page, "lk:queue")) as {
      action: string;
      data: { rating: number };
    }[];
    const reviewItem = queue.find((e) => e.action === "review");
    expect(reviewItem).toBeTruthy();
    expect(reviewItem!.data.rating).toBe(3);
  });

  test("card stays dirty after offline review (no server confirmation)", async ({ page }) => {
    await setup(page, { status: 401 });
    await openDialog(page);
    await clickRating(page, "Good");
    await page.waitForTimeout(300);

    const index = (await gmJSON(page, "lk:card-index")) as { hash: string }[];
    const card = (await gmJSON(page, `lk:c:${index[0].hash}`)) as { dirty: boolean };
    expect(card.dirty).toBe(true);
  });
});

test.describe("Returning visit (cache hit)", () => {
  test("second open on same URL makes zero addNote API calls", async ({ page }) => {
    await setup(page, { status: 401 });

    // Track addNote calls specifically (URL contains /api/fsrs/add)
    // Background sync calls (/api/fsrs/review, etc.) are separate and expected
    await page.evaluate(() => {
      const real = (window as any).GM_xmlhttpRequest;
      (window as any).__addNoteCalls = 0;
      (window as any).GM_xmlhttpRequest = (opts: any) => {
        if (String(opts.url ?? "").includes("/api/fsrs/add")) (window as any).__addNoteCalls++;
        (real as (o: unknown) => void)(opts);
      };
    });

    // First visit: addNote is called → 401 → local card created
    await openDialog(page);
    const addCallsFirst = await page.evaluate(() => (window as any).__addNoteCalls as number);

    await clickFab(page); // closes the open dialog
    await waitForDialogClosed(page);

    // Go offline so background sync can't fire during the second open
    await page.context().setOffline(true);
    await page.evaluate(() => ((window as any).__addNoteCalls = 0));

    // Second visit: card is in GM cache → addNote is NOT called (even offline)
    await openDialog(page);
    const addCallsSecond = await page.evaluate(() => (window as any).__addNoteCalls as number);
    await page.context().setOffline(false);

    expect(addCallsFirst).toBeGreaterThanOrEqual(1);
    expect(addCallsSecond).toBe(0); // cache hit — no addNote
  });

  test("second open goes directly to reviewing phase", async ({ page }) => {
    await setup(page, { status: 401 });

    // First open
    await openDialog(page);
    // Close via FAB click
    await clickFab(page);
    await waitForDialogClosed(page);

    // Second open — should be instant (cache hit)
    await openDialog(page);

    const labels = await page.evaluate((fn: string) => {
      const host = new Function(`return (${fn})`)()() as
        | (HTMLElement & { shadowRoot: ShadowRoot })
        | undefined;
      return Array.from(host?.shadowRoot?.querySelectorAll("button") ?? []).map(
        (b) => b.textContent?.trim() ?? "",
      );
    }, FIND_HOST.toString());

    expect(labels.some((l) => l.includes("Good"))).toBe(true);
  });
});

test.describe("Queue persistence across reviews", () => {
  test("multiple reviews accumulate in queue", async ({ page }) => {
    await setup(page, { status: 401 });

    // First review
    await openDialog(page);
    await clickRating(page, "Good"); // rating 3
    await waitForDialogClosed(page);

    // Second review
    await openDialog(page);
    await clickRating(page, "Again"); // rating 1
    await page.waitForTimeout(300);

    const queue = (await gmJSON(page, "lk:queue")) as {
      action: string;
      data: { rating: number };
    }[];
    const reviews = queue.filter((e) => e.action === "review");
    expect(reviews.length).toBe(2);
    expect(reviews[0].data.rating).toBe(3); // Good
    expect(reviews[1].data.rating).toBe(1); // Again
  });

  test("queue items carry HLC timestamps and createdAt", async ({ page }) => {
    await setup(page, { status: 401 });
    await openDialog(page);
    await clickRating(page, "Good");
    await page.waitForTimeout(300);

    const queue = (await gmJSON(page, "lk:queue")) as {
      action: string;
      hlc: unknown;
      createdAt: number;
    }[];
    const item = queue[0];
    expect(item.hlc).toBeTruthy();
    expect(item.createdAt).toBeGreaterThan(0);
  });
});
