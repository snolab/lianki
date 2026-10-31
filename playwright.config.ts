import { defineConfig, devices } from "@playwright/test";

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
  workers: process.env.CI ? 4 : undefined,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    // Silent (owner, 2026-10-31): scripts/qa/silent.mjs has the rest.
    launchOptions: { args: ["--mute-audio"] },
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
