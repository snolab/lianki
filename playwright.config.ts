import { defineConfig, devices } from "@playwright/test";
import { budget } from "./scripts/qa/load-budget.mjs";

const BASE_URL = process.env.LIANKI_URL || "https://lianki.com";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  // Retry locally too (not just in CI): qa:all drives four suites against one
  // wrangler dev worker, where cold-start/contention causes occasional
  // waitForFunction timeouts. Without retries those flakes false-fail the
  // pre-push gate, pushing people toward --no-verify (forbidden).
  retries: 2,
  // Playwright's own 30 s per test and 5 s per expect, as load budgets: under
  // two gate runs at once the same page takes longer (scripts/qa/load-budget.mjs).
  timeout: budget(30_000),
  expect: { timeout: budget(5_000) },
  workers: process.env.CI ? 4 : undefined,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    // Silent (owner, 2026-10-31): scripts/qa/silent.mjs has the rest.
    launchOptions: { args: ["--mute-audio", "--use-fake-device-for-media-stream"] },
    extraHTTPHeaders: {
      Accept: "text/html,application/xhtml+xml",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
