import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["unit/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["app/fsrs-helpers.ts", "app/ems.ts", "lib/normalizeUrl.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
