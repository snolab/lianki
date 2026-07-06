import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Standalone Vite + React SPA (the website). Shares framework-neutral code via
// @lianki/core. In dev, /api is proxied to a Lianki API origin (the apps/api
// Worker, or production) — set VITE_API_ORIGIN to override. The final
// production serve topology (apps/api Worker serving this build vs a separate
// deploy) is a follow-up decision; see apps/web/README.md.
const API_ORIGIN = process.env.VITE_API_ORIGIN || "https://www.lianki.com";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@lianki/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": { target: API_ORIGIN, changeOrigin: true, secure: true },
    },
  },
});
