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
    // Single instance of React + intlayer so the IntlayerProvider context (from
    // @lianki/web's Root) is the same one useIntlayer reads — otherwise the
    // dictionary lookup returns empty and home renders a blank <h1>.
    dedupe: ["react", "react-dom", "react-intlayer", "intlayer"],
    alias: {
      // vite-intlayer aliases @intlayer/dictionaries-entry to the generated
      // registry, but that alias doesn't reach @cloudflare/vite-plugin's client
      // environment — so useIntlayer fell back to the empty stub (blank home
      // title). Point it at the generated registry explicitly.
      "@intlayer/dictionaries-entry": fileURLToPath(
        new URL("./.intlayer/main/dictionaries.mjs", import.meta.url),
      ),
      "@lianki/web": fileURLToPath(new URL("../web/src/Root.tsx", import.meta.url)),
      "@lianki/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("../..", import.meta.url)),
    },
  },
});
