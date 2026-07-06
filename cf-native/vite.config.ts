import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";

// `@` resolves to the repo root so the CF-native worker can import the shared,
// framework-agnostic core (lib/core, lib/repos, lib/normalizeUrl, …) directly —
// the same files the Next app uses, single source of truth.
export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    alias: {
      "@lianki/core": fileURLToPath(new URL("../packages/core/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("..", import.meta.url)),
    },
  },
});
