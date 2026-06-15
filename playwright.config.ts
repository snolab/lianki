import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.LIANKI_URL || "https://www.lianki.com";

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
