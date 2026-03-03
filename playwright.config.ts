import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.LIANKI_URL || "https://www.lianki.com";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
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
