import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { intlayerPlugin } from "vite-intlayer";
import { fileURLToPath } from "node:url";

// `@` resolves to the repo root so this Worker can import the shared,
// framework-agnostic code (lib/repos, lib/d1, …) directly — the same files the
// Next app uses, single source of truth. Extracted shared code lives in
// @lianki/core.
export default defineConfig({
  plugins: [react(), cloudflare(), intlayerPlugin()],
  resolve: {
    alias: {
      "@lianki/web": fileURLToPath(new URL("../web/src/Root.tsx", import.meta.url)),
      "@lianki/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("../..", import.meta.url)),
    },
  },
});
