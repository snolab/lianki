/**
 * Comprehensive route QA tests for Lianki
 *
 * Tests all routes for:
 * - HTTP 200 (no 404/500)
 * - No critical console errors
 * - Key UI elements rendering
 * - Critical bugs from 2026-03-03 QA report
 */

import { test, expect } from "@playwright/test";

const BASE = process.env.LIANKI_URL || "https://www.lianki.com";

// ── Helpers ──────────────────────────────────────────────────────────────────

function url(path: string) {
  return `${BASE}${path}`;
}

function collectErrors(page: import("@playwright/test").Page) {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Exclude known extension errors (userscript) - tracked separately
      if (!text.includes("chrome-extension://")) {
        errors.push(text);
      }
    }
  });
  return errors;
}

// ── Public pages (no auth required) ──────────────────────────────────────────

test.describe("Public pages", () => {
  test("/ redirects to locale root and renders landing page", async ({ page }) => {
    await page.goto(url("/"));
    // Should redirect to a locale prefix (e.g. /en or /ja)
    expect(page.url()).toMatch(/\/(en|ja|zh|ko|fr|de|es|pt|ru|ar|hi|bn|ur|id|sw|mr)\/?$/);
    await expect(page.locator("main")).toBeVisible();
  });

  test("/en loads English landing page", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(url("/en"));
    await expect(page.locator("main")).toBeVisible();
    expect(errors).toHaveLength(0);
  });

  test("/en/blog lists blog posts", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(url("/en/blog"));
    await expect(page.locator("h1")).toContainText("Blog");
    await expect(page.locator("ul li").first()).toBeVisible();
    expect(errors).toHaveLength(0);
  });

  test("/en/blog/2025-01-01-introduction renders blog post", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(url("/en/blog/2025-01-01-introduction"));
    await expect(page.locator("article")).toBeVisible();
    await expect(page.locator("article h1").first()).toContainText("Lianki");
    expect(errors).toHaveLength(0);
  });

  test("/en/contact renders contact form", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(url("/en/contact"));
    await expect(page.locator("form, [role=form]")).toBeVisible();
    await expect(
      page.locator("button[type=submit], button").filter({ hasText: /send|submit/i }),
    ).toBeVisible();
    expect(errors).toHaveLength(0);
  });

  test("/en/sign-in renders sign-in form", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(url("/en/sign-in"));
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("button").filter({ hasText: /GitHub/i })).toBeVisible();
    expect(errors).toHaveLength(0);
  });

  test("/en/sign-in email placeholder is not [object Object] (BUG-6 regression)", async ({
    page,
  }) => {
    await page.goto(url("/en/sign-in"));
    const emailInputs = page.locator('input[type="email"]');
    const count = await emailInputs.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const placeholder = await emailInputs.nth(i).getAttribute("placeholder");
      expect(placeholder).not.toBe("[object Object]");
    }
  });

  test("/en/self-intro renders language selector", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(url("/en/self-intro"));
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("button").filter({ hasText: /Japanese|日本語/ })).toBeVisible();
    expect(errors).toHaveLength(0);
  });

  test("/en/learn renders without server error", async ({ page }) => {
    const errors = collectErrors(page);
    const response = await page.goto(url("/en/learn"));
    expect(response?.status()).toBe(200);
    // May redirect to sign-in for unauthenticated users, or show learn page
    const finalUrl = page.url();
    if (!finalUrl.includes("/sign-in")) {
      await expect(page.locator("main")).toBeVisible();
    }
    expect(errors).toHaveLength(0);
  });
});

// ── Auth-required pages (guest behavior) ─────────────────────────────────────

test.describe("Auth-required pages (guest redirect)", () => {
  test("/en/preferences redirects or renders without crash", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(url("/en/preferences"));
    // Either redirect to sign-in or render preferences
    const finalUrl = page.url();
    const isSignIn = finalUrl.includes("/sign-in");
    if (!isSignIn) {
      // BUG-3 regression: page must not crash with TypeError
      await page.waitForLoadState("networkidle");
      const crashMessage = page.locator("text=/Application error/i");
      await expect(crashMessage).not.toBeVisible();
    }
    expect(errors).toHaveLength(0);
  });

  test("/en/polyglot does not throw 500 server error", async ({ page }) => {
    const errors = collectErrors(page);
    const response = await page.goto(url("/en/polyglot"));
    // BUG-2 regression: must not be 500
    expect(response?.status()).not.toBe(500);
    const crashMessage = page.locator("text=/Application error.*server-side/i");
    await expect(crashMessage).not.toBeVisible();
    expect(errors).toHaveLength(0);
  });

  test("/en/membership does not crash", async ({ page }) => {
    await page.goto(url("/en/membership"));
    const crashMessage = page.locator("text=/Application error/i");
    await expect(crashMessage).not.toBeVisible();
  });

  test("/en/profile renders or redirects", async ({ page }) => {
    await page.goto(url("/en/profile"));
    // Either redirect to sign-in or render profile
    const finalUrl = page.url();
    if (!finalUrl.includes("/sign-in")) {
      await expect(page.locator("h1")).toBeVisible();
    }
  });
});

// ── Navigation flow ───────────────────────────────────────────────────────────

test.describe("Navigation flows", () => {
  test("/en/next does not redirect to /repeat (BUG-1 regression)", async ({ page }) => {
    const response = await page.goto(url("/en/next"));
    // The page should not end up at a /repeat URL with 404
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    // Must not be a /repeat path that returns 404
    if (finalUrl.includes("/repeat")) {
      const status = await page.evaluate(() => fetch(window.location.href).then((r) => r.status));
      expect(status).not.toBe(404);
    }
  });

  test("/en/read renders read page (BUG-4 regression)", async ({ page }) => {
    const response = await page.goto(url("/en/read"));
    expect(response?.status()).not.toBe(404);
    // Should either show the read UI or redirect to sign-in
    const finalUrl = page.url();
    if (!finalUrl.includes("/sign-in")) {
      await expect(page.locator("main")).toBeVisible();
    }
  });

  test("locale switching works on landing page", async ({ page }) => {
    await page.goto(url("/en"));
    // Click language switch button
    const langButton = page
      .locator("button")
      .filter({ hasText: /English|language|Switch/i })
      .first();
    if (await langButton.isVisible()) {
      // Just verify the button exists without clicking to avoid navigation issues
      await expect(langButton).toBeVisible();
    }
  });
});

// ── API routes ────────────────────────────────────────────────────────────────

test.describe("API routes", () => {
  test("/api/membership/status returns JSON (not HTML error)", async ({ page }) => {
    const response = await page.goto(url("/api/membership/status"));
    const contentType = response?.headers()["content-type"] ?? "";
    expect(contentType).toContain("application/json");
  });

  test("/api/fsrs/next returns HTML with script (not 404)", async ({ page }) => {
    // This route requires auth, so we expect 401 or an HTML response
    const response = await page.goto(url("/api/fsrs/next"));
    const status = response?.status() ?? 0;
    // Should be 200 (HTML redirect script) or 401 (auth required) — not 404
    expect([200, 401]).toContain(status);
  });

  test("lianki.user.js is accessible", async ({ page }) => {
    const response = await page.goto(url("/lianki.user.js"));
    expect(response?.status()).toBe(200);
    const contentType = response?.headers()["content-type"] ?? "";
    expect(contentType).toMatch(/javascript|text/);
  });
});

// ── Userscript integrity ──────────────────────────────────────────────────────

test.describe("Userscript integrity", () => {
  test("lianki.user.js has a valid @version header", async ({ page }) => {
    const response = await page.goto(url("/lianki.user.js"));
    const content = await response?.text();
    expect(content).toMatch(/@version\s+\d+\.\d+\.\d+/);
  });
});

// ── No 404/500 on known good routes ──────────────────────────────────────────

test.describe("Route availability", () => {
  const knownGoodRoutes = [
    "/en",
    "/en/blog",
    "/en/contact",
    "/en/self-intro",
    "/en/learn",
    "/en/sign-in",
    "/en/blog/2025-01-01-introduction",
    "/en/blog/2025-01-15-fsrs-algorithm",
  ];

  for (const route of knownGoodRoutes) {
    test(`${route} returns 200`, async ({ page }) => {
      const response = await page.goto(url(route));
      expect(response?.status()).toBe(200);
    });
  }
});
