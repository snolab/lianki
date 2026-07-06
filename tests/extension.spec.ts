import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Integration smoke test for the MV3 extension: build packages/ext, load the
// unpacked dist/ into real Chromium, navigate to a matched page, and assert the
// content script executed (it stamps <html data-lianki-ext="loaded">).
//
// Extensions require a headed/new-headless Chromium — run under a display:
//   bun --cwd packages/ext run build
//   xvfb-run -a bunx playwright test tests/extension.spec.ts
//
// Skips itself (rather than failing) if dist/ hasn't been built.

// Resolved from the repo root (Playwright's cwd) to stay CommonJS-compatible.
const distPath = resolve(process.cwd(), "packages/ext/dist");

test("MV3 content script loads and runs in Chromium", async () => {
  test.skip(!existsSync(join(distPath, "content.js")), "build packages/ext first");

  const userDataDir = await mkdtemp(join(tmpdir(), "lianki-ext-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${distPath}`,
        `--load-extension=${distPath}`,
        "--no-sandbox",
      ],
    });
    const page = await context.newPage();
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
    // Wait for the content script to stamp its marker.
    await expect(page.locator("html")).toHaveAttribute("data-lianki-ext", "loaded", {
      timeout: 10_000,
    });
  } finally {
    await context?.close();
  }
});
